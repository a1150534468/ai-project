package vip

import (
	"testing"

	"gorm.io/gorm"
	"yc-billing/internal/pgtest"
	"yc-billing/internal/store"
)

func openTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	st, err := store.Open(pgtest.DSN())
	if err != nil {
		t.Fatalf("billing-postgres 不可用: %v", err)
	}
	pgtest.Serialize(t, st.DB)
	if err := st.DB.Exec("TRUNCATE vip_growth_ledgers, user_vip_states, vip_levels, point_buckets, accounts CASCADE").Error; err != nil {
		t.Fatalf("清理 VIP 测试数据失败: %v", err)
	}
	return st.DB
}
