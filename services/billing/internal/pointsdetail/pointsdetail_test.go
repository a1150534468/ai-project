package pointsdetail

import (
	"testing"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"yc-billing/internal/bucket"
	"yc-billing/internal/membership"
	"yc-billing/internal/model"
)

func openTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.PointBucket{}, &model.UserMembership{}, &model.MembershipCard{}, &model.MembershipGrant{}); err != nil {
		t.Fatal(err)
	}
	return db
}

func mustGrant(t *testing.T, db *gorm.DB, uid string, amt int64, exp *time.Time, src string) {
	t.Helper()
	if err := bucket.GrantPoints(db, uid, amt, exp, src); err != nil {
		t.Fatal(err)
	}
}

func TestComputeSplitsPermanentAndMembership(t *testing.T) {
	db := openTestDB(t)
	now := time.Now()
	exp := now.Add(24 * time.Hour)
	mustGrant(t, db, "u1", 145000, nil, bucket.SourceTopupPaid)   // 永久（充值）
	mustGrant(t, db, "u1", 142500, &exp, bucket.SourceMembership) // 临时（套餐）

	d, err := Compute(db, "u1", now)
	if err != nil {
		t.Fatal(err)
	}
	if d.PermanentPoints != 145000 || d.MembershipPoints != 142500 || d.TotalPoints != 287500 {
		t.Fatalf("permanent=%d membership=%d total=%d", d.PermanentPoints, d.MembershipPoints, d.TotalPoints)
	}
	if d.Period.Has || d.Membership.Has {
		t.Fatalf("无持卡时不应有 period/membership")
	}
}

func TestComputeCurrentPeriodUsed(t *testing.T) {
	db := openTestDB(t)
	now := time.Now()
	key, exp := membership.PeriodKeyAndExpiry("DAILY", now)

	card := model.MembershipCard{Name: "个人旗舰版", Cadence: "DAILY", GrantPoints: 198000, DurationDays: 30, PriceFen: 15900, Enabled: true}
	if err := db.Create(&card).Error; err != nil {
		t.Fatal(err)
	}
	um := model.UserMembership{UserID: "u1", CardID: card.ID, Cadence: "DAILY", GrantPoints: 198000, StartAt: now, ExpiresAt: now.Add(720 * time.Hour), Status: "active"}
	if err := db.Create(&um).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.MembershipGrant{UserMembershipID: um.ID, PeriodKey: key, Points: 198000, ExpiresAt: exp}).Error; err != nil {
		t.Fatal(err)
	}
	mustGrant(t, db, "u1", 142500, &exp, bucket.SourceMembership) // 已用 55500 → 剩 142500

	d, err := Compute(db, "u1", now)
	if err != nil {
		t.Fatal(err)
	}
	if !d.Period.Has {
		t.Fatal("expected current period")
	}
	if d.Period.Granted != 198000 || d.Period.Remaining != 142500 || d.Period.Used != 55500 {
		t.Fatalf("granted=%d remaining=%d used=%d", d.Period.Granted, d.Period.Remaining, d.Period.Used)
	}
	if d.Membership.CardName != "个人旗舰版" || d.Membership.Cadence != "DAILY" {
		t.Fatalf("membership=%+v", d.Membership)
	}
}

func TestComputeNoData(t *testing.T) {
	db := openTestDB(t)
	d, err := Compute(db, "nobody", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if d.TotalPoints != 0 || d.Period.Has || d.Membership.Has {
		t.Fatalf("expected zeros, got %+v", d)
	}
}

func TestComputeExpiredBucketIgnored(t *testing.T) {
	db := openTestDB(t)
	now := time.Now()
	past := now.Add(-24 * time.Hour)
	mustGrant(t, db, "u2", 100000, &past, bucket.SourceMembership) // 已过期临时点
	mustGrant(t, db, "u2", 5000, nil, bucket.SourceTopupPaid)      // 永久
	d, err := Compute(db, "u2", now)
	if err != nil {
		t.Fatal(err)
	}
	if d.MembershipPoints != 0 || d.PermanentPoints != 5000 || d.TotalPoints != 5000 {
		t.Fatalf("expired temp should be ignored, got %+v", d)
	}
}

func TestComputeMultipleMembershipsSameCadence(t *testing.T) {
	db := openTestDB(t)
	now := time.Now()
	key, exp := membership.PeriodKeyAndExpiry("DAILY", now)
	mk := func(name string, grant int64) model.UserMembership {
		card := model.MembershipCard{Name: name, Cadence: "DAILY", GrantPoints: grant, DurationDays: 30, PriceFen: 1000, Enabled: true}
		if err := db.Create(&card).Error; err != nil {
			t.Fatal(err)
		}
		um := model.UserMembership{UserID: "u3", CardID: card.ID, Cadence: "DAILY", GrantPoints: grant, StartAt: now, ExpiresAt: now.Add(720 * time.Hour), Status: "active"}
		if err := db.Create(&um).Error; err != nil {
			t.Fatal(err)
		}
		if err := db.Create(&model.MembershipGrant{UserMembershipID: um.ID, PeriodKey: key, Points: grant, ExpiresAt: exp}).Error; err != nil {
			t.Fatal(err)
		}
		return um
	}
	mk("卡A", 100000)
	mk("卡B", 50000)
	mustGrant(t, db, "u3", 60000, &exp, bucket.SourceMembership) // 卡A 本期剩余
	mustGrant(t, db, "u3", 40000, &exp, bucket.SourceMembership) // 卡B 本期剩余

	d, err := Compute(db, "u3", now)
	if err != nil {
		t.Fatal(err)
	}
	if d.Period.Granted != 150000 || d.Period.Remaining != 100000 || d.Period.Used != 50000 {
		t.Fatalf("granted=%d remaining=%d used=%d (expected 150000/100000/50000)", d.Period.Granted, d.Period.Remaining, d.Period.Used)
	}
}
