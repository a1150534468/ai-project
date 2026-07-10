package redeem

import (
	"testing"
	"time"

	"yc-billing/internal/model"
)

func TestGenerateBatchUnique(t *testing.T) {
	st := newStore(t)
	s := New(st)
	exp := time.Now().Add(24 * time.Hour)
	codes, err := s.Generate(GenerateArgs{
		GrantType: "BALANCE", GrantPayload: `{"points":100}`, Points: 100, Count: 5, ExpiresAt: &exp,
	})
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if len(codes) != 5 {
		t.Fatalf("want 5 codes got %d", len(codes))
	}
	seen := map[string]bool{}
	for _, c := range codes {
		if seen[c] {
			t.Fatalf("duplicate code %s", c)
		}
		seen[c] = true
	}
	var n int64
	st.DB.Model(&model.Redemption{}).Where("grant_type = ?", "BALANCE").Count(&n)
	if n != 5 {
		t.Fatalf("want 5 rows got %d", n)
	}
}

func TestListAndDisable(t *testing.T) {
	st := newStore(t)
	s := New(st)
	codes, _ := s.Generate(GenerateArgs{GrantType: "BALANCE", GrantPayload: `{"points":10}`, Points: 10, Count: 2})
	rows, err := s.List(ListFilter{Status: "unused", Limit: 50})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("want 2 got %d", len(rows))
	}
	if err := s.Disable(codes[0]); err != nil {
		t.Fatalf("disable: %v", err)
	}
	var r model.Redemption
	st.DB.First(&r, "code = ?", codes[0])
	if r.Status != "disabled" {
		t.Fatalf("want disabled got %s", r.Status)
	}
	// 停用后不可兑换
	if err := s.Redeem(codes[0], "u1"); err != ErrInvalidCode {
		t.Fatalf("disabled code should not redeem, got %v", err)
	}
}
