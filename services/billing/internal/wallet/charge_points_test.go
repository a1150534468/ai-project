package wallet

import (
	"testing"
)

func TestChargePointsIdempotent(t *testing.T) {
	st := newTestStore(t)
	seed(st, "u1", 1000)

	// 调用两次相同的 operationId，应该只扣一次
	err1 := ChargePoints(st.DB, "kb:quota:t1", "u1", 300, "kb_quota")
	if err1 != nil {
		t.Fatalf("first ChargePoints failed: %v", err1)
	}
	if bal(st, "u1") != 700 {
		t.Fatalf("after first charge want 700 got %d", bal(st, "u1"))
	}

	// 重放相同 operationId，应返回 nil 且不动账
	err2 := ChargePoints(st.DB, "kb:quota:t1", "u1", 300, "kb_quota")
	if err2 != nil {
		t.Fatalf("idempotent ChargePoints should not error, got %v", err2)
	}
	if bal(st, "u1") != 700 {
		t.Fatalf("after idempotent charge should still be 700 got %d", bal(st, "u1"))
	}
}

func TestChargePointsInsufficient(t *testing.T) {
	st := newTestStore(t)
	seed(st, "u1", 100)

	// 余额 100，要扣 300，应返回错误
	err := ChargePoints(st.DB, "op_insuff", "u1", 300, "kb_quota")
	if err == nil {
		t.Fatal("want error for insufficient balance, got nil")
	}

	// 余额应不变
	if bal(st, "u1") != 100 {
		t.Fatalf("insufficient charge should not deduct, want 100 got %d", bal(st, "u1"))
	}
}

func TestChargePointsZeroOrNegative(t *testing.T) {
	st := newTestStore(t)
	seed(st, "u1", 100)

	// 0 点应返回错误
	err := ChargePoints(st.DB, "op_zero", "u1", 0, "kb_quota")
	if err == nil {
		t.Fatal("want error for zero points")
	}

	// 负数点应返回错误
	err = ChargePoints(st.DB, "op_neg", "u1", -10, "kb_quota")
	if err == nil {
		t.Fatal("want error for negative points")
	}
}
