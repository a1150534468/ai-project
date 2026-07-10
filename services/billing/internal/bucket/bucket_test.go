package bucket

import (
	"testing"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"yc-billing/internal/model"
)

func openBucketTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.PointBucket{}); err != nil {
		t.Fatal(err)
	}
	return db
}

func ptr(t time.Time) *time.Time { return &t }

func TestGrantAndBalance(t *testing.T) {
	db := openBucketTestDB(t)
	if err := GrantPoints(db, "u1", 100, nil, "topup"); err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-time.Hour)
	if err := GrantPoints(db, "u1", 50, &past, "membership"); err != nil { // 已过期
		t.Fatal(err)
	}
	b, _ := Balance(db, "u1")
	if b != 100 { // 过期的 50 不计
		t.Fatalf("balance want 100 got %d", b)
	}
	// amount<=0 不建桶
	_ = GrantPoints(db, "u1", 0, nil, "x")
	var n int64
	db.Model(&model.PointBucket{}).Where("user_id=?", "u1").Count(&n)
	if n != 2 {
		t.Fatalf("want 2 buckets got %d", n)
	}
}

func TestConsumeOrderAndAlloc(t *testing.T) {
	db := openBucketTestDB(t)
	soon := time.Now().Add(2 * time.Hour)
	later := time.Now().Add(48 * time.Hour)
	GrantPoints(db, "u1", 30, &soon, "membership")  // 最早过期
	GrantPoints(db, "u1", 30, &later, "membership") // 次之
	GrantPoints(db, "u1", 100, nil, "topup")        // 永久最后
	var allocs []Alloc
	err := db.Transaction(func(tx *gorm.DB) error {
		a, e := ConsumeInTx(tx, "u1", 50) // 扣 30(soon) + 20(later)
		allocs = a
		return e
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(allocs) != 2 || allocs[0].Amount != 30 || allocs[1].Amount != 20 {
		t.Fatalf("alloc wrong: %+v", allocs)
	}
	b, _ := Balance(db, "u1")
	if b != 110 { // 160-50
		t.Fatalf("balance want 110 got %d", b)
	}
}

func TestConsumeInsufficient(t *testing.T) {
	db := openBucketTestDB(t)
	GrantPoints(db, "u1", 40, nil, "topup")
	err := db.Transaction(func(tx *gorm.DB) error {
		_, e := ConsumeInTx(tx, "u1", 100)
		return e
	})
	if err != ErrInsufficient {
		t.Fatalf("want ErrInsufficient got %v", err)
	}
	b, _ := Balance(db, "u1")
	if b != 40 { // 回滚后不变
		t.Fatalf("balance want 40 got %d", b)
	}
}

func TestRefundReverseSkipExpired(t *testing.T) {
	db := openBucketTestDB(t)
	soon := time.Now().Add(2 * time.Hour)
	GrantPoints(db, "u1", 30, &soon, "membership")
	GrantPoints(db, "u1", 100, nil, "topup")
	var allocs []Alloc
	db.Transaction(func(tx *gorm.DB) error {
		a, _ := ConsumeInTx(tx, "u1", 50) // 30(soon)+20(perm)
		allocs = a
		return nil
	})
	// 退 25：逆序先退永久桶(alloc[1]=20 全退)，再退 soon 桶(5)
	db.Transaction(func(tx *gorm.DB) error {
		return RefundInTx(tx, allocs, 25)
	})
	b, _ := Balance(db, "u1")
	if b != 105 { // 130(初) - 50(消费) + 25(退) = 105
		t.Fatalf("balance want 105 got %d", b)
	}
}

func TestRefundSkipExpiredBucket(t *testing.T) {
	db := openBucketTestDB(t)
	soon := time.Now().Add(2 * time.Hour)
	GrantPoints(db, "u1", 30, &soon, "membership")
	GrantPoints(db, "u1", 100, nil, "topup")
	var allocs []Alloc
	var soonBucketID uint
	err := db.Transaction(func(tx *gorm.DB) error {
		a, e := ConsumeInTx(tx, "u1", 50) // 30(soon)+20(perm)
		allocs = a
		if len(allocs) > 0 {
			soonBucketID = allocs[0].BucketID
		}
		return e
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(allocs) == 0 {
		t.Fatal("expected allocs from consume")
	}
	// 手动把 soon 桶过期时间改到过去
	past := time.Now().Add(-time.Hour)
	db.Model(&model.PointBucket{}).Where("id=?", soonBucketID).Update("expires_at", past)

	// 退 25：原桶 soon 已过期，跳过该笔退款；永久桶那 20 全退
	db.Transaction(func(tx *gorm.DB) error {
		return RefundInTx(tx, allocs, 25)
	})
	b, _ := Balance(db, "u1")
	if b != 100 { // 初 130 消费 50 = 80, 退 20(only 永久) = 100
		t.Fatalf("balance want 100 got %d", b)
	}
}
