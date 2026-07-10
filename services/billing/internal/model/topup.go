package model

import "time"

// 充值订单。TradeNo 唯一（我方交易号），幂等到账以它为键。
type TopUp struct {
	ID            uint   `gorm:"primaryKey"`
	TradeNo       string `gorm:"uniqueIndex;size:64;not null"`
	UserID        string `gorm:"index;size:64;not null"`
	AmountFen     int64  `gorm:"not null"`                        // 支付金额（分），整数
	Points        int64  `gorm:"not null"`                        // 到账积分
	Provider      string `gorm:"size:16;not null"`                // epay
	PaymentMethod string `gorm:"size:16"`                         // alipay|wxpay（回调回填）
	Status        string `gorm:"size:16;not null"`                // pending|success|closed
	Kind          string `gorm:"size:16;not null;default:points"` // points|membership|video_points
	CardID        uint   `gorm:"default:0"`
	CreatedAt     time.Time
	PaidAt        *time.Time
}

// 兑换码。Code 唯一；兑换原子一次性。多态授予：grantType + grantPayload(JSON 文本)。
type Redemption struct {
	ID           uint   `gorm:"primaryKey"`
	Code         string `gorm:"uniqueIndex;size:64;not null"`
	GrantType    string `gorm:"size:16;not null;default:BALANCE"` // BALANCE|MEMBERSHIP|FEATURE|PACKAGE
	GrantPayload string `gorm:"type:text"`                        // JSON：BALANCE {"points"}; MEMBERSHIP {"tier","days"}
	Points       int64  `gorm:"not null;default:0"`               // 旧码兼容 + BALANCE 冗余便于查询
	Status       string `gorm:"size:16;not null;default:unused"`  // unused|used|disabled
	UsedBy       string `gorm:"size:64"`
	BatchID      string `gorm:"size:64;index"` // 批次号，便于运营按批筛选
	ExpiresAt    *time.Time
	CreatedAt    time.Time
	UsedAt       *time.Time
}

// 订阅档位授予记录（设 groupRatio + 发放月度积分）
type Subscription struct {
	ID         uint    `gorm:"primaryKey"`
	UserID     string  `gorm:"index;size:64;not null"`
	Plan       string  `gorm:"size:32;not null"` // free|pro|enterprise
	GroupRatio float64 `gorm:"not null;default:1"`
	ExpiresAt  time.Time
	CreatedAt  time.Time
}

// 管理员余额调整流水：operationId 唯一=幂等键；记 delta/reason/adminId/前后余额。
type BalanceAdjustment struct {
	OperationID   string `gorm:"primaryKey;size:128"`
	UserID        string `gorm:"index;size:64;not null"`
	Delta         int64  `gorm:"not null"`
	Reason        string `gorm:"size:256"`
	AdminID       string `gorm:"size:64;not null"`
	AccountType   string `gorm:"size:16;not null;default:points"` // points | video
	BalanceBefore int64  `gorm:"not null"`
	BalanceAfter  int64  `gorm:"not null"`
	CreatedAt     time.Time
}
