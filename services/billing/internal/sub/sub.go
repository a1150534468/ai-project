package sub

import (
	"errors"
	"fmt"
	"time"

	"gorm.io/gorm"
	"yc-billing/internal/bucket"
	"yc-billing/internal/model"
	"yc-billing/internal/store"
)

// PlanConfig 定义订阅档位配置：ratio（组倍率）+ grant（月度发放积分）
type PlanConfig struct {
	Ratio float64
	Grant int64
}

var planConfigs = map[string]PlanConfig{
	"free": {
		Ratio: 1,
		Grant: 100,
	},
	"pro": {
		Ratio: 1,
		Grant: 10000,
	},
	"enterprise": {
		Ratio: 1,
		Grant: 100000,
	},
}

type Service struct {
	st *store.Store
}

func New(st *store.Store) *Service {
	return &Service{st: st}
}

// ApplyPlan 应用订阅档位：
// 1. 校验档位存在
// 2. 幂等：同月同档不重复发放
// 3. 创建 Subscription + 设 Account.GroupRatio + 原子加 balance
func (s *Service) ApplyPlan(userID, plan string) error {
	cfg, ok := planConfigs[plan]
	if !ok {
		return fmt.Errorf("未知档位: %s", plan)
	}

	return s.st.DB.Transaction(func(tx *gorm.DB) error {
		now := time.Now()
		monthStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location())
		monthEnd := monthStart.AddDate(0, 1, 0)

		// 检查本月是否已经为此用户创建过该档位的订阅
		var existingSub model.Subscription
		res := tx.Where(
			"user_id = ? AND plan = ? AND created_at >= ? AND created_at < ?",
			userID, plan, monthStart, monthEnd,
		).First(&existingSub)

		if res.Error == nil {
			// 本月已存在该档位订阅，幂等返回
			return nil
		}

		if !errors.Is(res.Error, gorm.ErrRecordNotFound) {
			return res.Error
		}

		// 创建新的订阅记录
		sub := model.Subscription{
			UserID:     userID,
			Plan:       plan,
			GroupRatio: cfg.Ratio,
			ExpiresAt:  now.AddDate(0, 1, 0), // +1 month
			CreatedAt:  now,
		}
		if err := tx.Create(&sub).Error; err != nil {
			return err
		}

		// 发放档位积分（永久桶）
		if err := bucket.GrantPoints(tx, userID, cfg.Grant, nil, "membership"); err != nil {
			return err
		}

		// 设置或更新账户的 GroupRatio
		// 先尝试找到账户
		var acc model.Account
		accRes := tx.Where("user_id = ?", userID).First(&acc)

		if accRes.Error == nil {
			// 账户已存在，仅更新 GroupRatio
			if err := tx.Model(&acc).Update("group_ratio", cfg.Ratio).Error; err != nil {
				return err
			}
		} else if errors.Is(accRes.Error, gorm.ErrRecordNotFound) {
			// 账户不存在，创建新账户（只设 GroupRatio）
			if err := tx.Create(&model.Account{
				UserID:    userID,
				GroupRatio: cfg.Ratio,
			}).Error; err != nil {
				return err
			}
		} else {
			return accRes.Error
		}

		return nil
	})
}

// GrantInTx 在给定事务内授予会员（兑换码 MEMBERSHIP 路径专用，按天叠加）：
// 设/建账户 GroupRatio + 发放档位积分 + 新增一条按天计的 Subscription（从 max(now, 现有最晚到期) 起叠加 days）。
// 与月度 ApplyPlan 语义不同（这里按天、可叠加），故独立函数；共享 planConfigs。
func GrantInTx(tx *gorm.DB, userID, plan string, days int) error {
	cfg, ok := planConfigs[plan]
	if !ok {
		return fmt.Errorf("未知档位: %s", plan)
	}
	if days <= 0 {
		days = 30
	}
	now := time.Now()

	// 叠加起点：现有最晚未过期到期时间，否则 now
	base := now
	var latest model.Subscription
	if err := tx.Where("user_id = ?", userID).Order("expires_at desc").First(&latest).Error; err == nil {
		if latest.ExpiresAt.After(base) {
			base = latest.ExpiresAt
		}
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}
	s := model.Subscription{
		UserID: userID, Plan: plan, GroupRatio: cfg.Ratio,
		ExpiresAt: base.AddDate(0, 0, days), CreatedAt: now,
	}
	if err := tx.Create(&s).Error; err != nil {
		return err
	}

	// 发放档位积分（永久桶）
	if err := bucket.GrantPoints(tx, userID, cfg.Grant, nil, "membership"); err != nil {
		return err
	}

	// 设/建账户 GroupRatio
	var acc model.Account
	err := tx.Where("user_id = ?", userID).First(&acc).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return tx.Create(&model.Account{UserID: userID, GroupRatio: cfg.Ratio}).Error
	}
	if err != nil {
		return err
	}
	return tx.Model(&model.Account{}).Where("user_id = ?", userID).Update("group_ratio", cfg.Ratio).Error
}
