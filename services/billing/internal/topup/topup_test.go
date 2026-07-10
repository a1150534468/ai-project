package topup

import (
	"sync"
	"testing"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"yc-billing/internal/bucket"
	"yc-billing/internal/model"
	"yc-billing/internal/pgtest"
	"yc-billing/internal/store"
	"yc-billing/internal/videopoint"
)

// newStore 打开测试数据库，清理表。如果数据库不可用，跳过测试。
func newStore(t *testing.T) *store.Store {
	dsn := pgtest.DSN()
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Skipf("billing-postgres 不可用: %v", err)
	}

	if err := db.AutoMigrate(&model.Account{}, &model.PointBucket{}, &model.VideoPointAccount{}, &model.UsageRecord{}, &model.TopUp{}, &model.Redemption{}, &model.Subscription{}); err != nil {
		t.Fatalf("AutoMigrate failed: %v", err)
	}
	// 清理表：保证测试隔离
	pgtest.Serialize(t, db)
	db.Exec("TRUNCATE point_buckets, video_point_accounts, accounts, usage_records, top_ups, redemptions, subscriptions CASCADE")

	return &store.Store{DB: db}
}

// seedTopUp 在测试中创建待付款充值订单
func seedTopUp(st *store.Store, tradeNo, userID string, amountFen, points int64, status string) {
	seedTopUpWithKind(st, tradeNo, userID, amountFen, points, status, "points")
}

func seedTopUpWithKind(st *store.Store, tradeNo, userID string, amountFen, points int64, status, kind string) {
	st.DB.Create(&model.TopUp{
		TradeNo:   tradeNo,
		UserID:    userID,
		AmountFen: amountFen,
		Points:    points,
		Provider:  "epay",
		Status:    status,
		Kind:      kind,
		CreatedAt: time.Now(),
	})
}

// balanceOf 查询桶余额
func balanceOf(st *store.Store, userID string) int64 {
	b, _ := bucket.Balance(st.DB, userID)
	return b
}

func videoBalanceOf(st *store.Store, userID string) int64 {
	b, _ := videopoint.Balance(st.DB, userID)
	return b
}

// TestCreditIdempotent 重复调用 CreditByTradeNo 3 次，应只到账一次（幂等）
func TestCreditIdempotent(t *testing.T) {
	st := newStore(t)
	svc := New(st)

	const userID = "u1"
	const tradeNo = "t1"
	const amountFen = 1900
	const points = 1000

	seedTopUp(st, tradeNo, userID, amountFen, points, "pending")

	// 重复回调 3 次
	for i := 0; i < 3; i++ {
		if err := svc.CreditByTradeNo(tradeNo, "alipay"); err != nil {
			t.Fatalf("CreditByTradeNo 失败: %v", err)
		}
	}

	// 验证：余额应只增加一次（1000），不是 3000
	bal := balanceOf(st, userID)
	if bal != points {
		t.Fatalf("重复到账应只加一次=%d, got %d", points, bal)
	}

	// 验证：订单状态应为 success
	var o model.TopUp
	st.DB.First(&o, "trade_no = ?", tradeNo)
	if o.Status != "success" {
		t.Fatalf("订单状态应为 success, got %s", o.Status)
	}
	if o.PaymentMethod != "alipay" {
		t.Fatalf("支付方式应为 alipay, got %s", o.PaymentMethod)
	}
}

func TestCreditVideoPointsDoesNotGrantComputePoints(t *testing.T) {
	st := newStore(t)
	svc := New(st)

	const userID = "u-video"
	const tradeNo = "t-video"
	const amountFen = 2500
	const points = 2500

	seedTopUpWithKind(st, tradeNo, userID, amountFen, points, "pending", "video_points")
	if err := svc.CreditByTradeNo(tradeNo, "alipay"); err != nil {
		t.Fatalf("CreditByTradeNo 失败: %v", err)
	}

	if got := videoBalanceOf(st, userID); got != points {
		t.Fatalf("视频点余额应增加 %d, got %d", points, got)
	}
	if got := balanceOf(st, userID); got != 0 {
		t.Fatalf("视频点充值不应增加算力点余额, got %d", got)
	}
}

// TestCreditConcurrent 10 个并发 goroutine 同时调用 CreditByTradeNo，应只到账一次
func TestCreditConcurrent(t *testing.T) {
	st := newStore(t)
	svc := New(st)

	const userID = "u2"
	const tradeNo = "t2"
	const amountFen = 1900
	const points = 1000

	seedTopUp(st, tradeNo, userID, amountFen, points, "pending")

	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := svc.CreditByTradeNo(tradeNo, "wxpay"); err != nil {
				t.Errorf("CreditByTradeNo 失败: %v", err)
			}
		}()
	}
	wg.Wait()

	// 验证：余额应只增加一次（1000），不是 10000
	bal := balanceOf(st, userID)
	if bal != points {
		t.Fatalf("并发到账应只加一次=%d, got %d", points, bal)
	}

	// 验证：订单状态应为 success
	var o model.TopUp
	st.DB.First(&o, "trade_no = ?", tradeNo)
	if o.Status != "success" {
		t.Fatalf("订单状态应为 success, got %s", o.Status)
	}
}

// TestCreditNonExistent 订单不存在时应幂等（不报错，但也不创建账户）
func TestCreditNonExistent(t *testing.T) {
	st := newStore(t)
	svc := New(st)

	// 调用不存在的订单
	err := svc.CreditByTradeNo("nonexistent", "alipay")
	if err != nil {
		t.Fatalf("订单不存在应返回 nil, got %v", err)
	}

	// 验证：不应创建任何账户
	var count int64
	st.DB.Model(&model.Account{}).Count(&count)
	if count != 0 {
		t.Fatalf("订单不存在不应创建账户, count=%d", count)
	}
}

// TestCreditAlreadySuccess 订单已成功时应幂等（不再加余额）
func TestCreditAlreadySuccess(t *testing.T) {
	st := newStore(t)
	svc := New(st)

	const userID = "u3"
	const tradeNo = "t3"
	const points = 1000

	// 创建已成功的订单
	st.DB.Create(&model.TopUp{
		TradeNo:       tradeNo,
		UserID:        userID,
		AmountFen:     1900,
		Points:        points,
		Provider:      "epay",
		Status:        "success",
		PaymentMethod: "alipay",
		CreatedAt:     time.Now(),
		PaidAt:        &time.Time{},
	})

	// 调用 CreditByTradeNo（幂等）
	if err := svc.CreditByTradeNo(tradeNo, "wxpay"); err != nil {
		t.Fatalf("CreditByTradeNo 失败: %v", err)
	}

	// 验证：余额仍为 0（不再加）
	bal := balanceOf(st, userID)
	if bal != 0 {
		t.Fatalf("已成功订单不应再加余额, got %d", bal)
	}
}
