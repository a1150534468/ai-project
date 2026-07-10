package membership

import (
	"testing"
	"time"

	"gorm.io/gorm"
	"yc-billing/internal/bucket"
	"yc-billing/internal/model"
	"yc-billing/internal/pgtest"
	"yc-billing/internal/store"
)

func newStore(t *testing.T) *store.Store {
	dsn := pgtest.DSN()
	s, err := store.Open(dsn)
	if err != nil {
		t.Skipf("billing-postgres 不可用: %v", err)
	}
	pgtest.Serialize(t, s.DB)
	s.DB.Exec("TRUNCATE membership_cards, user_memberships, membership_grants, point_buckets CASCADE")
	return s
}

func TestPeriodKeyAndExpiry(t *testing.T) {
	loc := time.Local
	d := time.Date(2026, 6, 28, 15, 0, 0, 0, loc) // 周日
	k, exp := PeriodKeyAndExpiry("DAILY", d)
	if k != "20260628" || !exp.Equal(time.Date(2026, 6, 29, 0, 0, 0, 0, loc)) {
		t.Fatalf("daily: %s %v", k, exp)
	}
	k, exp = PeriodKeyAndExpiry("MONTHLY", d)
	if k != "202606" || !exp.Equal(time.Date(2026, 7, 1, 0, 0, 0, 0, loc)) {
		t.Fatalf("monthly: %s %v", k, exp)
	}
	// 周日 → 本周日 24:00 = 次日 6-29 0 点
	_, exp = PeriodKeyAndExpiry("WEEKLY", d)
	if !exp.Equal(time.Date(2026, 6, 29, 0, 0, 0, 0, loc)) {
		t.Fatalf("weekly expiry: %v", exp)
	}
}

func TestGrantPeriodIdempotent(t *testing.T) {
	st := newStore(t)
	s := New(st)
	m := model.UserMembership{UserID: "u1", CardID: 1, Cadence: "DAILY", GrantPoints: 500,
		StartAt: time.Now(), ExpiresAt: time.Now().AddDate(0, 0, 30), Status: "active"}
	st.DB.Create(&m)
	now := time.Now()
	if err := s.GrantPeriod(m, now); err != nil {
		t.Fatal(err)
	}
	if b, _ := bucket.Balance(st.DB, "u1"); b != 500 {
		t.Fatalf("after grant want 500 got %d", b)
	}
	// 同期重跑 no-op
	if err := s.GrantPeriod(m, now); err != nil {
		t.Fatal(err)
	}
	if b, _ := bucket.Balance(st.DB, "u1"); b != 500 {
		t.Fatalf("idempotent want 500 got %d", b)
	}
	var n int64
	st.DB.Model(&model.MembershipGrant{}).Where("user_membership_id = ?", m.ID).Count(&n)
	if n != 1 {
		t.Fatalf("grant ledger want 1 got %d", n)
	}
}

func TestActivateAndFirstGrant(t *testing.T) {
	st := newStore(t)
	s := New(st)
	card := model.MembershipCard{Name: "月卡", PriceFen: 30000, DurationDays: 30, Cadence: "DAILY", GrantPoints: 1000, Enabled: true}
	st.DB.Create(&card)
	// 激活 + 首发（购买回调里会调）
	if err := st.DB.Transaction(func(tx *gorm.DB) error {
		return s.ActivateInTx(tx, "u1", card, time.Now())
	}); err != nil {
		t.Fatal(err)
	}
	var um model.UserMembership
	if err := st.DB.First(&um, "user_id = ?", "u1").Error; err != nil {
		t.Fatalf("membership not created: %v", err)
	}
	if um.Status != "active" || um.GrantPoints != 1000 {
		t.Fatalf("unexpected membership: %+v", um)
	}
	if b, _ := bucket.Balance(st.DB, "u1"); b != 1000 { // 首期发点
		t.Fatalf("first grant want 1000 got %d", b)
	}
}

func TestListEnabledCards(t *testing.T) {
	st := newStore(t)
	s := New(st)
	st.DB.Create(&model.MembershipCard{Name: "A", PriceFen: 100, DurationDays: 30, Cadence: "DAILY", GrantPoints: 10, Enabled: true})
	b := model.MembershipCard{Name: "B", PriceFen: 200, DurationDays: 30, Cadence: "DAILY", GrantPoints: 20, Enabled: true}
	st.DB.Create(&b)
	st.DB.Model(&b).Update("enabled", false)
	cards, _ := s.ListCards(true)
	if len(cards) != 1 || cards[0].Name != "A" {
		t.Fatalf("enabled cards: %+v", cards)
	}
}
