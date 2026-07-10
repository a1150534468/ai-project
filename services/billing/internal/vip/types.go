package vip

import (
	"errors"
	"strings"
	"time"
)

const DiscountFullBps = 10000

var (
	ErrInvalidLevel       = errors.New("invalid vip level")
	ErrInvalidGrowthInput = errors.New("invalid vip growth input")
	ErrInvalidUserID      = errors.New("invalid vip user id")
	ErrLevelOccupied      = errors.New("vip level occupied")
)

type UpsertLevelInput struct {
	ID              uint
	Name            string
	SortOrder       int
	ThresholdRMBFen int64
	RechargeRatio   int64
	DiscountBps     int
	Enabled         bool
	UpgradeEnabled  bool
}

type AddGrowthInput struct {
	OperationID             string
	UserID                  string
	SourceType              string
	GrowthPoints            int64
	RelatedUsageOperationID string
	RelatedTradeNo          string
	Note                    string
	OccurredAt              time.Time
}

type ReverseGrowthInput struct {
	OperationID             string
	UserID                  string
	SourceType              string
	GrowthPoints            int64
	RelatedUsageOperationID string
	RelatedTradeNo          string
	Note                    string
	OccurredAt              time.Time
}

type Summary struct {
	UserID             string `json:"userId"`
	LevelID            uint   `json:"levelId"`
	LevelName          string `json:"levelName"`
	DiscountBps        int    `json:"discountBps"`
	GrowthPoints       int64  `json:"growthPoints"`
	NextLevelID        *uint  `json:"nextLevelId"`
	NextLevelName      string `json:"nextLevelName"`
	NextThreshold      int64  `json:"nextThreshold"`
	PointsToNextLevel  int64  `json:"pointsToNextLevel"`
	HighestLevel       bool   `json:"highestLevel"`
	UpgradedAtUnixNano int64  `json:"upgradedAtUnixNano"`
}

type defaultLevel struct {
	name         string
	thresholdFen int64
	discountBps  int
}

var defaultLevels = []defaultLevel{
	{name: "普通会员", thresholdFen: 0, discountBps: 10000},
	{name: "银卡会员", thresholdFen: 10000, discountBps: 9000},
	{name: "金卡会员", thresholdFen: 30000, discountBps: 8500},
	{name: "白金卡会员", thresholdFen: 100000, discountBps: 8000},
	{name: "黑金卡会员", thresholdFen: 300000, discountBps: 7500},
	{name: "钻石会员", thresholdFen: 1000000, discountBps: 7000},
	{name: "银钻会员", thresholdFen: 3000000, discountBps: 6500},
	{name: "金钻会员", thresholdFen: 10000000, discountBps: 6000},
	{name: "白金钻会员", thresholdFen: 30000000, discountBps: 5500},
	{name: "黑钻会员", thresholdFen: 100000000, discountBps: 5000},
}

func trimField(value string) string {
	return strings.TrimSpace(value)
}
