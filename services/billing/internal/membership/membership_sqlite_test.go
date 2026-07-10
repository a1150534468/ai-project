package membership

import (
	"fmt"
	"testing"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"yc-billing/internal/model"
	"yc-billing/internal/store"
)

func openMembershipSQLiteStore(t *testing.T) *store.Store {
	t.Helper()

	dsn := fmt.Sprintf("file:%s?mode=memory&cache=shared", t.Name())
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1)

	if err := db.AutoMigrate(
		&model.PointBucket{},
		&model.MembershipCard{},
		&model.UserMembership{},
		&model.MembershipGrant{},
	); err != nil {
		t.Fatal(err)
	}

	return &store.Store{DB: db}
}

func TestGrantPeriodUsesMembershipSource(t *testing.T) {
	// Given
	st := openMembershipSQLiteStore(t)
	svc := New(st)
	now := time.Now()
	member := model.UserMembership{
		UserID:      "u1",
		CardID:      1,
		Cadence:     "DAILY",
		GrantPoints: 500,
		StartAt:     now,
		ExpiresAt:   now.AddDate(0, 0, 30),
		Status:      "active",
	}
	if err := st.DB.Create(&member).Error; err != nil {
		t.Fatal(err)
	}

	// When
	if err := svc.GrantPeriod(member, now); err != nil {
		t.Fatal(err)
	}

	// Then
	var bucket model.PointBucket
	if err := st.DB.First(&bucket, "user_id = ?", "u1").Error; err != nil {
		t.Fatal(err)
	}
	if bucket.Source != "membership" || bucket.Remaining != 500 {
		t.Fatalf("bucket=%+v, want membership source with 500 points", bucket)
	}
}

func TestActivateInTxUsesMembershipSourceForFirstGrant(t *testing.T) {
	// Given
	st := openMembershipSQLiteStore(t)
	svc := New(st)
	now := time.Now()
	card := model.MembershipCard{
		Name:         "月卡",
		PriceFen:     3000,
		DurationDays: 30,
		Cadence:      "DAILY",
		GrantPoints:  800,
		Enabled:      true,
	}
	if err := st.DB.Create(&card).Error; err != nil {
		t.Fatal(err)
	}

	// When
	if err := st.DB.Transaction(func(tx *gorm.DB) error {
		return svc.ActivateInTx(tx, "u1", card, now)
	}); err != nil {
		t.Fatal(err)
	}

	// Then
	var bucket model.PointBucket
	if err := st.DB.First(&bucket, "user_id = ?", "u1").Error; err != nil {
		t.Fatal(err)
	}
	if bucket.Source != "membership" || bucket.Remaining != 800 {
		t.Fatalf("bucket=%+v, want membership source with 800 points", bucket)
	}
}
