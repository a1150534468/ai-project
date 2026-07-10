// Package pgtest 为共享同一测试库(ycbilling)的各包提供跨进程串行化。
//
// billing 的多数集成测试都连到同一个 Postgres 并在准备数据前 TRUNCATE 共享表。
// go test ./... 默认会把各包作为独立进程并行跑，导致它们互相清表污染、随机失败。
// 这里用一个 Postgres 会话级 advisory lock 让各测试进程在数据库层自动串行，
// 效果等同 go test -p 1，但无需依赖调用方记得加参数。
package pgtest

import (
	"context"
	"database/sql"
	"os"
	"strings"
	"sync"
	"testing"

	"gorm.io/gorm"
)

const defaultBillingTestDSN = "postgres://ycbilling:billing-postgres-password-placeholder@localhost:5434/ycbilling?sslmode=disable"

// DSN returns the shared billing integration-test database URL.
func DSN() string {
	if dsn := strings.TrimSpace(os.Getenv("BILLING_TEST_DATABASE_URL")); dsn != "" {
		return dsn
	}
	return defaultBillingTestDSN
}

// serialLockKey 所有 billing 测试共用的固定 advisory lock key（任意常量即可）。
const serialLockKey int64 = 0x79636231 // "ycb1"

var (
	once     sync.Once
	lockErr  error
	heldConn *sql.Conn // 持有到进程退出以保活会话锁，不可回收
)

// Serialize 让当前测试进程独占共享测试库：进程内首次调用获取一个 advisory lock 并持有到进程退出，
// 使并行的各包在数据库层自动串行、消除互相 TRUNCATE 的污染。
// 幂等且可重入：同一进程多次调用（含单个测试内多次打开 store）都安全，不会自锁。
// 应在任何 TRUNCATE / 数据准备之前调用；数据库不可用而被 t.Skip 的测试不会走到这里。
func Serialize(t *testing.T, db *gorm.DB) {
	t.Helper()
	once.Do(func() {
		sqlDB, err := db.DB()
		if err != nil {
			lockErr = err
			return
		}
		conn, err := sqlDB.Conn(context.Background())
		if err != nil {
			lockErr = err
			return
		}
		if _, err := conn.ExecContext(context.Background(), "SELECT pg_advisory_lock($1)", serialLockKey); err != nil {
			_ = conn.Close()
			lockErr = err
			return
		}
		// 故意不释放：进程退出时连接关闭，会话锁自动释放。
		heldConn = conn
	})
	if lockErr != nil {
		t.Fatalf("pgtest: 获取串行锁失败: %v", lockErr)
	}
}
