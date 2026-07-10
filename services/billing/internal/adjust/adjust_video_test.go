package adjust

import (
	"testing"

	"yc-billing/internal/model"
	"yc-billing/internal/videopoint"
)

// TestAdjustVideo 覆盖管理端调视频点余额：充值、扣减、不足拒绝、幂等。
func TestAdjustVideo(t *testing.T) {
	st := newStore(t)
	s := New(st)

	// 充值 +300
	before, after, err := s.AdjustVideo("vadj1", "vu1", 300, "视频点补偿", "admin1")
	if err != nil || before != 0 || after != 300 {
		t.Fatalf("credit want 0->300 got %d->%d err %v", before, after, err)
	}
	if bal, _ := videopoint.Balance(st.DB, "vu1"); bal != 300 {
		t.Fatalf("video balance want 300 got %d", bal)
	}
	// 流水应记为 video 账户
	var led model.BalanceAdjustment
	st.DB.First(&led, "operation_id = ?", "vadj1")
	if led.AccountType != "video" {
		t.Fatalf("ledger accountType want video got %q", led.AccountType)
	}

	// 扣减 -120
	_, after2, err := s.AdjustVideo("vadj2", "vu1", -120, "扣减", "admin1")
	if err != nil || after2 != 180 {
		t.Fatalf("deduct want 180 got %d err %v", after2, err)
	}
	if bal, _ := videopoint.Balance(st.DB, "vu1"); bal != 180 {
		t.Fatalf("video balance want 180 got %d", bal)
	}

	// 不足拒绝，不写流水、不变余额
	_, _, err = s.AdjustVideo("vadj3", "vu1", -1000, "超扣", "admin1")
	if err != ErrInsufficient {
		t.Fatalf("want ErrInsufficient got %v", err)
	}
	var n int64
	st.DB.Model(&model.BalanceAdjustment{}).Where("operation_id = ?", "vadj3").Count(&n)
	if n != 0 {
		t.Fatalf("insufficient must not write ledger, got %d", n)
	}
	if bal, _ := videopoint.Balance(st.DB, "vu1"); bal != 180 {
		t.Fatalf("balance must not change on error, want 180 got %d", bal)
	}

	// 幂等：同 opID 重放不双计
	_, r1, _ := s.AdjustVideo("vadj4", "vu1", 20, "x", "admin1")
	_, r2, err := s.AdjustVideo("vadj4", "vu1", 20, "x", "admin1")
	if err != nil || r1 != 200 || r2 != 200 {
		t.Fatalf("idempotent want 200/200 got %d/%d err %v", r1, r2, err)
	}
	if bal, _ := videopoint.Balance(st.DB, "vu1"); bal != 200 {
		t.Fatalf("idempotent balance want 200 got %d", bal)
	}
}
