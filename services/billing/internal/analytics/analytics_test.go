package analytics

import (
	"fmt"
	"testing"
	"time"

	"ai-assistant-billing/internal/model"
	"ai-assistant-billing/internal/pgtest"
	"ai-assistant-billing/internal/store"
)

// newStore 打开测试数据库并清表。必须走 store.Open：它带 AutoMigrate，
// 保证本包在空库上也能自建 schema，不依赖其他包先跑过。
func newStore(t *testing.T) *store.Store {
	st, err := store.Open(pgtest.DSN())
	if err != nil {
		t.Skipf("billing-postgres 不可用: %v", err)
	}
	pgtest.Serialize(t, st.DB)
	st.DB.Exec("TRUNCATE top_ups, usage_records CASCADE")
	return st
}

func mkTopup(st *store.Store, user string, fen, points int64, paidAt time.Time) {
	st.DB.Create(&model.TopUp{
		TradeNo: "t_" + user + paidAt.Format("0102150405.000000"), UserID: user,
		AmountFen: fen, Points: points, Provider: "epay", Status: "success", PaidAt: &paidAt,
	})
}

func TestDailyAggregates(t *testing.T) {
	st := newStore(t)
	s := New(st)
	d1 := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	d2 := time.Date(2026, 6, 2, 10, 0, 0, 0, time.UTC)
	mkTopup(st, "u1", 1000, 100, d1) // u1 首笔在 6-1
	mkTopup(st, "u2", 2000, 200, d1) // u2 首笔在 6-1
	mkTopup(st, "u1", 500, 50, d2)   // u1 复购 6-2（非新付费）
	// 6-2 一条消耗
	settled := d2
	st.DB.Create(&model.UsageRecord{OperationID: "op1", UserID: "u1", Type: "chat", Model: "m", Status: "settled", ReservedPoints: 30, ActualPoints: 30, SettledAt: &settled})

	rows, err := s.DailyAggregates("2026-06-01", "2026-06-02")
	if err != nil {
		t.Fatalf("daily: %v", err)
	}
	byDate := map[string]DailyRow{}
	for _, r := range rows {
		byDate[r.Date] = r
	}
	if byDate["2026-06-01"].RevenueFen != 3000 || byDate["2026-06-01"].TopupCount != 2 {
		t.Fatalf("6-1 revenue/count wrong: %+v", byDate["2026-06-01"])
	}
	if byDate["2026-06-01"].PayingUsers != 2 || byDate["2026-06-01"].NewPayingUsers != 2 {
		t.Fatalf("6-1 paying wrong: %+v", byDate["2026-06-01"])
	}
	if byDate["2026-06-02"].NewPayingUsers != 0 {
		t.Fatalf("6-2 newPaying should be 0 (u1 复购): %+v", byDate["2026-06-02"])
	}
	if byDate["2026-06-02"].ConsumedPoints != 30 {
		t.Fatalf("6-2 consumed wrong: %+v", byDate["2026-06-02"])
	}
}

func TestRevenueByUsers(t *testing.T) {
	st := newStore(t)
	s := New(st)
	d1 := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	mkTopup(st, "u1", 1000, 100, d1)
	mkTopup(st, "u3", 9999, 999, d1) // 不在查询集
	m, err := s.RevenueByUsers([]string{"u1", "u2"})
	if err != nil {
		t.Fatalf("rbu: %v", err)
	}
	if len(m["u1"]) != 1 || m["u1"][0].AmountFen != 1000 {
		t.Fatalf("u1 wrong: %+v", m["u1"])
	}
	if len(m["u2"]) != 0 {
		t.Fatalf("u2 should be empty")
	}
	if _, ok := m["u3"]; ok {
		t.Fatalf("u3 should not be present")
	}
}

func TestRankingsAggregateSettledUsage(t *testing.T) {
	st := newStore(t)
	s := New(st)
	d1 := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	d2 := time.Date(2026, 6, 2, 10, 0, 0, 0, time.UTC)
	st.DB.Create(&model.UsageRecord{
		OperationID: "r1", UserID: "u1", Type: "chat", Model: "m1", Status: "settled",
		ActualPoints: 30, InputTokens: 100, OutputTokens: 20, SettledAt: &d1,
	})
	st.DB.Create(&model.UsageRecord{
		OperationID: "r2", UserID: "u1", Type: "image_generation", Model: "image_generation", Status: "settled",
		ActualPoints: 70, InputTokens: 0, OutputTokens: 0, SettledAt: &d2,
	})
	st.DB.Create(&model.UsageRecord{
		OperationID: "r3", UserID: "u2", Type: "chat", Model: "m1", Status: "reserved",
		ActualPoints: 999, InputTokens: 999, SettledAt: &d2,
	})

	rankings, err := s.Rankings("2026-06-01", "2026-06-02", 10)
	if err != nil {
		t.Fatalf("rankings: %v", err)
	}
	if len(rankings.Users) == 0 || rankings.Users[0].Key != "u1" || rankings.Users[0].Points != 100 || rankings.Users[0].Tokens != 120 {
		t.Fatalf("user ranking wrong: %+v", rankings.Users)
	}
	if len(rankings.Models) == 0 || rankings.Models[0].Key != "image_generation" || rankings.Models[0].Points != 70 {
		t.Fatalf("model ranking wrong: %+v", rankings.Models)
	}
	if len(rankings.Features) == 0 || rankings.Features[0].Key != "image_generation" || rankings.Features[0].Points != 70 {
		t.Fatalf("feature ranking wrong: %+v", rankings.Features)
	}
}

func TestSalesAndBalancesAggregateBillingTables(t *testing.T) {
	st := newStore(t)
	s := New(st)
	st.DB.Exec("TRUNCATE membership_cards, point_buckets, video_point_accounts CASCADE")
	card := model.MembershipCard{Name: "Pro", PriceFen: 9900, DurationDays: 30, Cadence: "MONTHLY", GrantPoints: 1000, Enabled: true}
	if err := st.DB.Create(&card).Error; err != nil {
		t.Fatalf("create card: %v", err)
	}
	d1 := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	d2 := time.Date(2026, 6, 2, 10, 0, 0, 0, time.UTC)
	st.DB.Create(&model.TopUp{TradeNo: "m1", UserID: "u1", AmountFen: 9900, Points: 0, Provider: "epay", Status: "success", Kind: "membership", CardID: card.ID, PaidAt: &d1})
	st.DB.Create(&model.TopUp{TradeNo: "m2", UserID: "u2", AmountFen: 9900, Points: 0, Provider: "epay", Status: "success", Kind: "membership", CardID: card.ID, PaidAt: &d2})
	st.DB.Create(&model.TopUp{TradeNo: "p1", UserID: "u1", AmountFen: 1900, Points: 1000, Provider: "epay", Status: "success", Kind: "points", PaidAt: &d2})
	st.DB.Create(&model.PointBucket{UserID: "u1", Remaining: 100, Source: "test", CreatedAt: d1})
	st.DB.Create(&model.PointBucket{UserID: "u2", Remaining: 0, Source: "test", CreatedAt: d1})
	st.DB.Create(&model.PointBucket{UserID: "u3", Remaining: 50, Source: "test", CreatedAt: d1})
	// 视频点独立账户：只统计 balance>0
	st.DB.Create(&model.VideoPointAccount{UserID: "u1", Balance: 300})
	st.DB.Create(&model.VideoPointAccount{UserID: "u2", Balance: 0})

	sales, err := s.Sales("2026-06-01", "2026-06-02")
	if err != nil {
		t.Fatalf("sales: %v", err)
	}
	if len(sales.Memberships) != 1 || sales.Memberships[0].Key != fmt.Sprint(card.ID) || sales.Memberships[0].Orders != 2 || sales.Memberships[0].RevenueFen != 19800 {
		t.Fatalf("membership sales wrong: %+v", sales.Memberships)
	}
	if len(sales.RechargePackages) != 1 || sales.RechargePackages[0].Orders != 1 || sales.RechargePackages[0].Points != 1000 {
		t.Fatalf("recharge package sales wrong: %+v", sales.RechargePackages)
	}

	balances, err := s.BalanceSummary()
	if err != nil {
		t.Fatalf("balance summary: %v", err)
	}
	if balances.TotalBalance != 150 || balances.UsersWithBalance != 2 {
		t.Fatalf("balance summary wrong: %+v", balances)
	}
	if balances.VideoPointsBalance != 300 {
		t.Fatalf("video points balance wrong: %+v", balances)
	}
}

func TestUserSummaryAggregatesRechargeConsumptionAndTokens(t *testing.T) {
	st := newStore(t)
	s := New(st)
	d1 := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	d2 := time.Date(2026, 6, 2, 10, 0, 0, 0, time.UTC)
	mkTopup(st, "u1", 1000, 100, d1)
	mkTopup(st, "u1", 2000, 200, d2)
	st.DB.Create(&model.UsageRecord{OperationID: "us1", UserID: "u1", Type: "chat", Model: "m1", Status: "settled", ActualPoints: 30, InputTokens: 100, OutputTokens: 20, SettledAt: &d1})
	st.DB.Create(&model.UsageRecord{OperationID: "us2", UserID: "u1", Type: "chat", Model: "m1", Status: "settled", ActualPoints: 70, InputTokens: 200, OutputTokens: 40, SettledAt: &d2})
	st.DB.Create(&model.UsageRecord{OperationID: "us3", UserID: "u2", Type: "chat", Model: "m1", Status: "settled", ActualPoints: 999, InputTokens: 999, SettledAt: &d2})

	row, err := s.UserSummary("u1", "2026-06-02")
	if err != nil {
		t.Fatalf("user summary: %v", err)
	}
	if row.TodayRechargeFen != 2000 || row.TotalRechargeFen != 3000 ||
		row.TodayConsumptionPoints != 70 || row.TotalConsumptionPoints != 100 ||
		row.TodayTokens != 240 || row.TotalTokens != 360 {
		t.Fatalf("user summary wrong: %+v", row)
	}
}

func TestSummaryByUsers(t *testing.T) {
	st := newStore(t)
	s := New(st)
	d1 := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	d2 := time.Date(2026, 6, 2, 10, 0, 0, 0, time.UTC)
	// u1：两笔成功充值 600+400=1000 分、一条已结算消耗 300 点
	mkTopup(st, "u1", 600, 60, d1)
	mkTopup(st, "u1", 400, 40, d2)
	st.DB.Create(&model.UsageRecord{OperationID: "op1", UserID: "u1", Type: "chat", Model: "m1", Status: "settled", ActualPoints: 300, SettledAt: &d2})
	// u2：一笔成功充值 500 分、无消耗
	mkTopup(st, "u2", 500, 50, d1)
	// u3 不插数据（测试无数据的用户不出现）

	m, err := s.SummaryByUsers([]string{"u1", "u2", "u3"})
	if err != nil {
		t.Fatalf("SummaryByUsers: %v", err)
	}
	if len(m) != 2 {
		t.Fatalf("expected 2 entries, got %d: %+v", len(m), m)
	}
	if m["u1"].TotalRechargeFen != 1000 || m["u1"].TotalRechargeOrders != 2 || m["u1"].TotalConsumptionPoints != 300 {
		t.Fatalf("u1 wrong: %+v", m["u1"])
	}
	if m["u2"].TotalRechargeFen != 500 || m["u2"].TotalRechargeOrders != 1 || m["u2"].TotalConsumptionPoints != 0 {
		t.Fatalf("u2 wrong: %+v", m["u2"])
	}
	if _, ok := m["u3"]; ok {
		t.Fatalf("u3 should not be present")
	}
}
