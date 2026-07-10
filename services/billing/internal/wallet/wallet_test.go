package wallet

import (
	"fmt"
	"sync"
	"testing"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"yc-billing/internal/bucket"
	"yc-billing/internal/model"
	"yc-billing/internal/store"
	"yc-billing/internal/vip"
)

func openWalletTestStore(t *testing.T) *store.Store {
	t.Helper()
	return openWalletTestStoreWithVIPSeed(t, true)
}

func openWalletTestStoreWithoutVIPSeed(t *testing.T) *store.Store {
	t.Helper()
	return openWalletTestStoreWithVIPSeed(t, false)
}

func openWalletTestStoreWithVIPSeed(t *testing.T, seedVIP bool) *store.Store {
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
		&model.UsageRecord{},
		&model.VipLevel{},
		&model.UserVipState{},
		&model.VipGrowthLedger{},
	); err != nil {
		t.Fatal(err)
	}
	if seedVIP {
		if err := vip.New(db).EnsureDefaultLevels(100); err != nil {
			t.Fatal(err)
		}
	}
	return &store.Store{DB: db}
}

func newTestStore(t *testing.T) *store.Store {
	t.Helper()
	return openWalletTestStore(t)
}

func seed(st *store.Store, userID string, balance int64) {
	_ = bucket.GrantPoints(st.DB, userID, balance, nil, bucket.SourceSystem)
}

func bal(st *store.Store, userID string) int64 {
	b, _ := bucket.Balance(st.DB, userID)
	return b
}

func TestReserveInsufficient(t *testing.T) {
	st := openWalletTestStore(t)
	w := New(st)
	seed(st, "u1", 50)
	_, err := w.Reserve("op1", "u1", "chat", "m", 100)
	if err != ErrInsufficient {
		t.Fatalf("want ErrInsufficient got %v", err)
	}
}

func TestReserveSettleRefundDelta(t *testing.T) {
	st := openWalletTestStore(t)
	w := New(st)
	seed(st, "u1", 1000)
	if _, err := w.Reserve("op2", "u1", "chat", "m", 300); err != nil {
		t.Fatal(err)
	}
	if bal(st, "u1") != 700 {
		t.Fatalf("reserve 后应 700, got %d", bal(st, "u1"))
	}
	if err := w.Settle("op2", 120); err != nil {
		t.Fatal(err)
	}
	if bal(st, "u1") != 880 {
		t.Fatalf("settle 后应 880, got %d", bal(st, "u1"))
	}
}

func TestReserveIdempotent(t *testing.T) {
	st := openWalletTestStore(t)
	w := New(st)
	seed(st, "u1", 1000)
	if _, err := w.Reserve("op3", "u1", "chat", "m", 200); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Reserve("op3", "u1", "chat", "m", 200); err != nil {
		t.Fatal(err)
	}
	if bal(st, "u1") != 800 {
		t.Fatalf("重放应只扣一次=800, got %d", bal(st, "u1"))
	}
}

func TestSettleIdempotent(t *testing.T) {
	st := openWalletTestStore(t)
	w := New(st)
	seed(st, "u1", 1000)
	if _, err := w.Reserve("op4", "u1", "chat", "m", 300); err != nil {
		t.Fatal(err)
	}
	if err := w.Settle("op4", 100); err != nil {
		t.Fatal(err)
	}
	if err := w.Settle("op4", 100); err != nil {
		t.Fatal(err)
	}
	if bal(st, "u1") != 900 {
		t.Fatalf("结算重放应=900, got %d", bal(st, "u1"))
	}
}

func TestConcurrentReserveNoOversell(t *testing.T) {
	st := openWalletTestStore(t)
	w := New(st)
	seed(st, "u1", 100)
	var wg sync.WaitGroup
	ok := 0
	var mu sync.Mutex
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if _, err := w.Reserve(fmt.Sprintf("c%d", i), "u1", "chat", "m", 30); err == nil {
				mu.Lock()
				ok++
				mu.Unlock()
			}
		}(i)
	}
	wg.Wait()
	if ok != 3 || bal(st, "u1") < 0 {
		t.Fatalf("并发应仅 3 次成功且不超卖, ok=%d bal=%d", ok, bal(st, "u1"))
	}
}

func TestReserveSettleAcrossBucketsRefund(t *testing.T) {
	st := openWalletTestStore(t)
	w := New(st)
	soon := time.Now().Add(2 * time.Hour)
	if err := bucket.GrantPoints(st.DB, "u1", 30, &soon, bucket.SourceMembership); err != nil {
		t.Fatal(err)
	}
	if err := bucket.GrantPoints(st.DB, "u1", 100, nil, bucket.SourceTopupPaid); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Reserve("op1", "u1", "chat", "m", 50); err != nil {
		t.Fatal(err)
	}
	if bal(st, "u1") != 80 {
		t.Fatalf("after reserve want 80 got %d", bal(st, "u1"))
	}
	if err := w.Settle("op1", 20); err != nil {
		t.Fatal(err)
	}
	if bal(st, "u1") != 110 {
		t.Fatalf("after settle want 110 got %d", bal(st, "u1"))
	}
	var perm model.PointBucket
	if err := st.DB.First(&perm, "user_id=? AND expires_at IS NULL", "u1").Error; err != nil {
		t.Fatal(err)
	}
	if perm.Remaining != 100 {
		t.Fatalf("perm bucket want 100 got %d", perm.Remaining)
	}
}
