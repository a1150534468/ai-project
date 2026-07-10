package resource

import (
	"hash/fnv"

	"gorm.io/gorm"
)

func lockUsageOperation(tx *gorm.DB, operationID string) error {
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
