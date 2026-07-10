package vip

import (
	"hash/fnv"

	"gorm.io/gorm"
)

const (
	defaultSeedLockKey int64 = 4101000001
)

func lockDefaultSeed(tx *gorm.DB) error {
	return advisoryXactLock(tx, defaultSeedLockKey)
}

func lockGrowthOperation(tx *gorm.DB, operationID string) error {
	return advisoryXactLock(tx, hashLockKey(operationID))
}

func advisoryXactLock(tx *gorm.DB, key int64) error {
	if tx.Dialector == nil || tx.Dialector.Name() != "postgres" {
		return nil
	}
	return tx.Exec(
		"SELECT pg_advisory_xact_lock(CAST(? AS bigint))",
		key,
	).Error
}

func hashLockKey(value string) int64 {
	hasher := fnv.New64a()
	_, _ = hasher.Write([]byte(value))
	return int64(hasher.Sum64())
}
