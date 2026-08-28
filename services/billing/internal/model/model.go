package model

import "time"

// 钱包账户：balance 为积分(points)整数；余额扣减全程整数原子运算
type Account struct {
	UserID     string  `gorm:"primaryKey;size:64"`
	GroupRatio float64 `gorm:"not null;default:1"` // 用户组倍率（订阅档位在 2b 调整）
	UpdatedAt  time.Time
}

// 算力点桶：每笔发放一行。expiresAt=nil 永久。余额=Σ 未过期桶 remaining。
type PointBucket struct {
	ID            uint       `gorm:"primaryKey"`
	UserID        string     `gorm:"index:idx_bucket_user_exp;size:64;not null"`
	Remaining     int64      `gorm:"not null"`
	ExpiresAt     *time.Time `gorm:"index:idx_bucket_user_exp"`
	Source        string     `gorm:"size:32;not null"`
	AllowedModels string     `gorm:"type:text"` // 预留(本轮不启用)
	CreatedAt     time.Time
}

// 视频点账户：视频生成独立余额，不参与算力点活动和会员折扣。
type VideoPointAccount struct {
	UserID    string `gorm:"primaryKey;size:64"`
	Balance   int64  `gorm:"not null;default:0"`
	UpdatedAt time.Time
}

// 价表：按模型配 ratio（移植 NewAPI ModelRatio/CompletionRatio）
type PriceRule struct {
	Model           string  `gorm:"primaryKey;size:128" json:"model"`
	DisplayName     string  `gorm:"size:128" json:"displayName"` // 前端展示名
	ModelRatio      float64 `gorm:"not null" json:"modelRatio"`  // 兼容字段：每单位 prompt token 的倍率
	CompletionRatio float64 `gorm:"not null;default:1" json:"completionRatio"`

	InputPricePerMillion       float64 `gorm:"not null;default:0" json:"inputPricePerMillion"`       // 输入算力点/100W token
	OutputPricePerMillion      float64 `gorm:"not null;default:0" json:"outputPricePerMillion"`      // 输出算力点/100W token
	CacheInputPricePerMillion  float64 `gorm:"not null;default:0" json:"cacheInputPricePerMillion"`  // 缓存输入算力点/100W token
	CacheOutputPricePerMillion float64 `gorm:"not null;default:0" json:"cacheOutputPricePerMillion"` // 缓存输出算力点/100W token

	InputPriceRMBPerMillion       float64 `gorm:"column:input_price_rmb_per_million;not null;default:0" json:"inputPriceRmbPerMillion"`
	OutputPriceRMBPerMillion      float64 `gorm:"column:output_price_rmb_per_million;not null;default:0" json:"outputPriceRmbPerMillion"`
	CacheInputPriceRMBPerMillion  float64 `gorm:"column:cache_input_price_rmb_per_million;not null;default:0" json:"cacheInputPriceRmbPerMillion"`
	CacheOutputPriceRMBPerMillion float64 `gorm:"column:cache_output_price_rmb_per_million;not null;default:0" json:"cacheOutputPriceRmbPerMillion"`
	Description                   string  `gorm:"type:text" json:"description"`
	CapabilityTags                string  `gorm:"type:text" json:"tags"`
	Category                      string  `gorm:"size:32;not null;default:''" json:"category"` // 模型分类：语言模型/语音模型/视觉模型/向量模型 等
	ContextWindow                 int64   `gorm:"not null;default:0" json:"contextLength"`
	MaxOutputTokens               int64   `gorm:"not null;default:0" json:"maxOutputTokens"` // 单次输出上限；0=用后端默认
	UseCases                      string  `gorm:"type:text" json:"useCases"`
	MarketplaceSortOrder          int     `gorm:"not null;default:0" json:"sortOrder"`
	ShowInMarketplace             bool    `gorm:"not null;default:false" json:"showInMarketplace"`
	Enabled                       bool    `gorm:"not null;default:true" json:"enabled"`
}

// 用量/扣点记录：operationId 唯一 → 幂等键
type UsageRecord struct {
	OperationID       string `gorm:"primaryKey;size:128"` // turn:<id> / imgjob:<id> ...
	UserID            string `gorm:"index;size:64;not null"`
	Type              string `gorm:"size:32;not null"` // chat | image | embedding ...
	Model             string `gorm:"size:128;not null"`
	Status            string `gorm:"size:16;not null"` // reserved | settled | refunded
	ReservedPoints    int64  `gorm:"not null"`
	ActualPoints      int64  `gorm:"not null;default:0"`
	OriginalPoints    int64  `gorm:"not null;default:0"`
	VipLevelID        uint   `gorm:"not null;default:0"`
	VipLevelName      string `gorm:"size:64;not null;default:''"`
	VipDiscountBps    int    `gorm:"not null;default:10000"`
	VipSavedPoints    int64  `gorm:"not null;default:0"`
	VipGrowthPoints   int64  `gorm:"not null;default:0"`
	InputTokens       int64  `gorm:"not null;default:0"`
	OutputTokens      int64  `gorm:"not null;default:0"`
	CacheInputTokens  int64  `gorm:"not null;default:0"`
	CacheOutputTokens int64  `gorm:"not null;default:0"`
	Allocations       string `gorm:"type:text"` // JSON [{"bucketId":N,"amount":M}]，预扣分配明细
	CreatedAt         time.Time
	SettledAt         *time.Time
	// 预留有效期。为空时由 recon 兜底按全局 TTL（默认 10 分钟）回收；
	// 生命周期本就超过 TTL 的工作流（如桌宠按图计费预留要跨越「运行 + 等待授权 +
	// 结算宽限」）必须在预留时显式声明到期时刻，否则运行途中就会被 recon 以
	// actual=0 强行关账：后续每次真实调用都免费，且调用方 settle 时只会拿到
	// 静默的 0，无任何报错。
	ReservationExpiresAt *time.Time `gorm:"index"`
}

// 通用资源价表（按次/按量；模型按 token 仍在 PriceRule）。
type ResourcePrice struct {
	ResourceKey string    `gorm:"primaryKey;size:64" json:"resourceKey"`
	DisplayName string    `gorm:"size:128" json:"displayName"`
	PricingType string    `gorm:"size:16;not null" json:"pricingType"`  // PER_CALL | PER_UNIT | VIDEO_IO
	Rate        float64   `gorm:"not null" json:"rate"`                 // VIDEO_IO 时为输入视频每秒单价
	OutputRate  float64   `gorm:"not null;default:0" json:"outputRate"` // 仅 VIDEO_IO：输出视频每秒单价
	PerUnits    int64     `gorm:"not null;default:1" json:"perUnits"`
	Enabled     bool      `gorm:"not null;default:true" json:"enabled"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// 平台键值配置（如充值汇率）。
type PlatformConfig struct {
	Key   string `gorm:"primaryKey;size:64"`
	Value string `gorm:"not null"`
}

type VipLevel struct {
	ID                 uint      `gorm:"primaryKey" json:"id"`
	Name               string    `gorm:"size:64;not null" json:"name"`
	SortOrder          int       `gorm:"not null;index" json:"sortOrder"`
	ThresholdRMBFen    int64     `gorm:"not null;default:0" json:"thresholdRmbFen"`
	ThresholdPoints    int64     `gorm:"not null;default:0;index" json:"thresholdPoints"`
	SavedRechargeRatio int64     `gorm:"not null;default:100" json:"savedRechargeRatio"`
	DiscountBps        int       `gorm:"not null;default:10000" json:"discountBps"`
	Enabled            bool      `gorm:"not null;default:true" json:"enabled"`
	UpgradeEnabled     bool      `gorm:"not null;default:true" json:"upgradeEnabled"`
	CreatedAt          time.Time `json:"createdAt"`
	UpdatedAt          time.Time `json:"updatedAt"`
}

type UserVipState struct {
	UserID       string    `gorm:"primaryKey;size:64" json:"userId"`
	VipLevelID   uint      `gorm:"index;not null" json:"vipLevelId"`
	GrowthPoints int64     `gorm:"not null;default:0" json:"growthPoints"`
	UpgradedAt   time.Time `gorm:"not null" json:"upgradedAt"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

type VipGrowthLedger struct {
	ID                      uint      `gorm:"primaryKey" json:"id"`
	OperationID             string    `gorm:"uniqueIndex;size:128;not null" json:"operationId"`
	UserID                  string    `gorm:"index;size:64;not null" json:"userId"`
	SourceType              string    `gorm:"size:32;not null" json:"sourceType"`
	GrowthPoints            int64     `gorm:"not null" json:"growthPoints"`
	RelatedUsageOperationID string    `gorm:"size:128;index" json:"relatedUsageOperationId"`
	RelatedTradeNo          string    `gorm:"size:128;index" json:"relatedTradeNo"`
	VipLevelBefore          string    `gorm:"size:64;not null" json:"vipLevelBefore"`
	VipLevelAfter           string    `gorm:"size:64;not null" json:"vipLevelAfter"`
	Note                    string    `gorm:"type:text" json:"note"`
	CreatedAt               time.Time `json:"createdAt"`
}

// 月卡定义（admin 配）。
type MembershipCard struct {
	ID           uint      `gorm:"primaryKey" json:"id"`
	Name         string    `gorm:"size:64;not null" json:"name"`
	PriceFen     int64     `gorm:"not null" json:"priceFen"`               // 售价（分）
	DurationDays int       `gorm:"not null" json:"durationDays"`           // 有效期（天）
	Cadence      string    `gorm:"size:8;not null" json:"cadence"`         // DAILY|WEEKLY|MONTHLY
	GrantPoints  int64     `gorm:"not null" json:"grantPoints"`            // 每期发放临时算力点
	KbQuotaBytes int64     `gorm:"not null;default:0" json:"kbQuotaBytes"` // 知识库配额（字节）
	Enabled      bool      `gorm:"not null;default:true" json:"enabled"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

// 用户持卡（一次性买断的有效期窗口）。
type UserMembership struct {
	ID           uint      `gorm:"primaryKey"`
	UserID       string    `gorm:"index;size:64;not null"`
	CardID       uint      `gorm:"not null"`
	Cadence      string    `gorm:"size:8;not null"`    // 冗余卡的 cadence（卡改不影响已购）
	GrantPoints  int64     `gorm:"not null"`           // 冗余卡的每期发点
	KbQuotaBytes int64     `gorm:"not null;default:0"` // 冗余卡的知识库配额（字节）
	StartAt      time.Time `gorm:"not null"`
	ExpiresAt    time.Time `gorm:"index;not null"`                 // 买断到期
	Status       string    `gorm:"size:8;not null;default:active"` // active|expired
	CreatedAt    time.Time
}

// 周期发放台账：每用户每会员每期只发一次。
type MembershipGrant struct {
	ID               uint      `gorm:"primaryKey"`
	UserMembershipID uint      `gorm:"uniqueIndex:idx_grant_period;not null"`
	PeriodKey        string    `gorm:"uniqueIndex:idx_grant_period;size:16;not null"` // 日:20260628 周:2026W26 月:202606
	Points           int64     `gorm:"not null"`
	ExpiresAt        time.Time `gorm:"not null"` // 该期临时点过期时间
	CreatedAt        time.Time
}
