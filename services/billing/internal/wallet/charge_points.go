package wallet

import (
	"encoding/json"
	"errors"
	"time"

	"gorm.io/gorm"
	"ai-assistant-billing/internal/bucket"
	"ai-assistant-billing/internal/model"
)

// ChargePoints 固定点数幂等扣减（用于知识库配额等固定成本扣费）。
// opID 相同的重放调用返回 nil 且不二次扣减（幂等）。
// 余额不足返回错误，不修改账户。
func ChargePoints(db *gorm.DB, opID, userID string, points int64, kind string) error {
	if points <= 0 {
		return errors.New("points must be positive")
	}

	return db.Transaction(func(tx *gorm.DB) error {
		// 检查是否已存在相同 operationId 的记录
		var existing model.UsageRecord
		err := tx.First(&existing, "operation_id = ?", opID).Error
		if err == nil {
			// 记录已存在，幂等返回 nil（不二次扣）
			return nil
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}

		// 扣点
		allocs, e := bucket.ConsumeInTx(tx, userID, points)
		if errors.Is(e, bucket.ErrInsufficient) {
			return ErrInsufficient
		}
		if e != nil {
			return e
		}

		// 序列化 allocations
		allocJSON, _ := json.Marshal(allocs)
		now := time.Now()

		// 写入 UsageRecord（status=settled，表示一次性固定扣费）
		rec := model.UsageRecord{
			OperationID:    opID,
			UserID:         userID,
			Type:           kind,
			Model:          kind,
			Status:         "settled",
			ReservedPoints: points,
			ActualPoints:   points,
			Allocations:    string(allocJSON),
			CreatedAt:      now,
			SettledAt:      &now,
		}
		return tx.Create(&rec).Error
	})
}
