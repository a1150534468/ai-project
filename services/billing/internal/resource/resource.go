package resource

import (
	"encoding/json"
	"errors"
	"math"
	"sort"
	"strconv"
	"strings"

	"ai-assistant-billing/internal/billingmode"
	"ai-assistant-billing/internal/model"
	"ai-assistant-billing/internal/store"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var (
	ErrResourceNotPriced = errors.New("资源未配置计价或已停用")
	ErrInsufficient      = errors.New("余额不足")
)

type Service struct {
	st   *store.Store
	mode billingmode.Mode
}

func New(st *store.Store) *Service {
	return NewWithPricingMode(st, billingmode.Standard)
}

func NewWithPricingMode(st *store.Store, mode billingmode.Mode) *Service {
	return &Service{st: st, mode: mode}
}

// Quote 计算资源用量的算力点成本（ceil 取整）。
func (s *Service) Quote(resourceKey string, units int64) (int64, error) {
	var p model.ResourcePrice
	err := s.st.DB.First(&p, "resource_key = ? AND enabled = ?", resourceKey, true).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return 0, ErrResourceNotPriced
		}
		return 0, err
	}
	var cost int64
	switch p.PricingType {
	case "PER_CALL":
		cost = int64(math.Ceil(p.Rate))
	case "PER_UNIT":
		per := p.PerUnits
		if per <= 0 {
			per = 1
		}
		cost = int64(math.Ceil(p.Rate * float64(units) / float64(per)))
	case pricingTypeVideoIO:
		// 单量入口按纯输出计价（无输入视频场景兜底），公式与 QuoteVideoIO(0, units) 一致。
		cost = int64(math.Ceil(p.OutputRate * float64(units)))
	default:
		return 0, ErrResourceNotPriced
	}
	return s.mode.NormalizeCost(cost), nil
}

const pricingTypeVideoIO = "VIDEO_IO"

// QuoteVideoIO 计算「有输入视频」的复合成本（ceil 取整）：
// cost = 输入视频秒数 × 输入单价 + 输出视频秒数 × 输出单价。
// 对历史遗留的 PER_UNIT 定价做降级：按旧口径 输出秒数 × Rate 计价，避免管理员改配前无法生成。
func (s *Service) QuoteVideoIO(resourceKey string, inputSec, outputSec int64) (int64, error) {
	var p model.ResourcePrice
	err := s.st.DB.First(&p, "resource_key = ? AND enabled = ?", resourceKey, true).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return 0, ErrResourceNotPriced
		}
		return 0, err
	}
	if inputSec < 0 {
		inputSec = 0
	}
	if outputSec < 0 {
		outputSec = 0
	}
	var cost int64
	switch p.PricingType {
	case pricingTypeVideoIO:
		cost = int64(math.Ceil(p.Rate*float64(inputSec) + p.OutputRate*float64(outputSec)))
	case "PER_UNIT":
		per := p.PerUnits
		if per <= 0 {
			per = 1
		}
		cost = int64(math.Ceil(p.Rate * float64(outputSec) / float64(per)))
	default:
		return 0, ErrResourceNotPriced
	}
	return s.mode.NormalizeCost(cost), nil
}

const rechargeRatioKey = "recharge_points_per_yuan"
const defaultRechargeRatio = 100
const rechargePackagesKey = "recharge_packages"

const kbDefaultQuotaKey = "kb_default_quota_bytes"
const defaultKbQuotaBytes = int64(1073741824) // 1GB

const defaultImageResourceKey = "image_generation"
const defaultImageResourceRate = 10.0
const defaultImage1KResourceKey = "image_generation_1k"
const defaultImage2KResourceKey = "image_generation_2k"
const defaultImage4KResourceKey = "image_generation_4k"
const defaultNovelTextResourceKey = "novel_text_output"
const defaultNovelTextResourceRate = 1.0
const defaultNovelTextResourcePerUnits = int64(1000)
const defaultArticleWorkflowTextResourceKey = "article_workflow_text_output"
const defaultArticleWorkflowTextResourceRate = 1.0
const defaultArticleWorkflowTextResourcePerUnits = int64(1000)
const defaultNovelCoverResourceKey = "novel_cover_generation"
const defaultNovelCoverResourceRate = 10.0
const defaultEcomMasterResourceKey = "ecom_master_generation"
const defaultEcomMasterResourceRate = 10.0
const defaultEcomMaster1KResourceKey = "ecom_master_generation_1k"
const defaultEcomMaster2KResourceKey = "ecom_master_generation_2k"
const defaultEcomMaster4KResourceKey = "ecom_master_generation_4k"
const defaultEcomSegmentResourceKey = "ecom_segment_generation"
const defaultEcomSegmentResourceRate = 10.0
const defaultEcomSegment1KResourceKey = "ecom_segment_generation_1k"
const defaultEcomSegment2KResourceKey = "ecom_segment_generation_2k"
const defaultEcomSegment4KResourceKey = "ecom_segment_generation_4k"
const defaultEcomStitchResourceKey = "ecom_stitch"
const defaultEcomStitchResourceRate = 1.0
const defaultLocalBusinessPromoRender25sResourceKey = "local_business_promo_render_25s"
const defaultLocalBusinessPromoRender40sResourceKey = "local_business_promo_render_40s"
const defaultLocalBusinessPromoRender60sResourceKey = "local_business_promo_render_60s"
const defaultCodexPetV2PackageResourceKey = "codex_pet_v2_package"
const defaultCodexPetV2PackageResourceRate = 200.0

func videoDefaultPrice(resourceKey, displayName string) model.ResourcePrice {
	return model.ResourcePrice{
		ResourceKey: resourceKey,
		DisplayName: displayName,
		PricingType: "PER_UNIT",
		Rate:        0,
		PerUnits:    1,
		Enabled:     false,
	}
}

// videoIODefaultPrice 「有输入视频」默认价，采用复合计价 VIDEO_IO：Rate=输入单价/秒，OutputRate=输出单价/秒。
func videoIODefaultPrice(resourceKey, displayName string) model.ResourcePrice {
	return model.ResourcePrice{
		ResourceKey: resourceKey,
		DisplayName: displayName,
		PricingType: pricingTypeVideoIO,
		Rate:        0,
		OutputRate:  0,
		PerUnits:    1,
		Enabled:     false,
	}
}

func defaultVideoResourcePrices() []model.ResourcePrice {
	return []model.ResourcePrice{
		videoDefaultPrice("video_seedance_2_480p_text", "Seedance-2.0 480p 无输入视频"),
		videoIODefaultPrice("video_seedance_2_480p_with_video", "Seedance-2.0 480p 有输入视频"),
		videoDefaultPrice("video_seedance_2_720p_text", "Seedance-2.0 720p 无输入视频"),
		videoIODefaultPrice("video_seedance_2_720p_with_video", "Seedance-2.0 720p 有输入视频"),
		videoDefaultPrice("video_seedance_2_1080p_text", "Seedance-2.0 1080p 无输入视频"),
		videoIODefaultPrice("video_seedance_2_1080p_with_video", "Seedance-2.0 1080p 有输入视频"),
		videoDefaultPrice("video_seedance_2_4k_text", "Seedance-2.0 4k 无输入视频"),
		videoIODefaultPrice("video_seedance_2_4k_with_video", "Seedance-2.0 4k 有输入视频"),
		videoDefaultPrice("video_seedance_2_fast_480p_text", "Seedance-2.0 Fast 480p 无输入视频"),
		videoIODefaultPrice("video_seedance_2_fast_480p_with_video", "Seedance-2.0 Fast 480p 有输入视频"),
		videoDefaultPrice("video_seedance_2_fast_720p_text", "Seedance-2.0 Fast 720p 无输入视频"),
		videoIODefaultPrice("video_seedance_2_fast_720p_with_video", "Seedance-2.0 Fast 720p 有输入视频"),
		videoDefaultPrice("video_seedance_2_mini_480p_text", "Seedance-2.0 Mini 480p 无输入视频"),
		videoIODefaultPrice("video_seedance_2_mini_480p_with_video", "Seedance-2.0 Mini 480p 有输入视频"),
		videoDefaultPrice("video_seedance_2_mini_720p_text", "Seedance-2.0 Mini 720p 无输入视频"),
		videoIODefaultPrice("video_seedance_2_mini_720p_with_video", "Seedance-2.0 Mini 720p 有输入视频"),
	}
}

func (s *Service) EnsureDefaultResourcePrices() error {
	defaults := []model.ResourcePrice{
		{
			ResourceKey: defaultImageResourceKey,
			DisplayName: "图片生成",
			PricingType: "PER_UNIT",
			Rate:        defaultImageResourceRate,
			PerUnits:    1,
			Enabled:     true,
		},
		{
			ResourceKey: defaultImage1KResourceKey,
			DisplayName: "图片生成 1K",
			PricingType: "PER_UNIT",
			Rate:        10,
			PerUnits:    1,
			Enabled:     true,
		},
		{
			ResourceKey: defaultImage2KResourceKey,
			DisplayName: "图片生成 2K",
			PricingType: "PER_UNIT",
			Rate:        20,
			PerUnits:    1,
			Enabled:     true,
		},
		{
			ResourceKey: defaultImage4KResourceKey,
			DisplayName: "图片生成 4K",
			PricingType: "PER_UNIT",
			Rate:        40,
			PerUnits:    1,
			Enabled:     true,
		},
		{
			ResourceKey: defaultNovelTextResourceKey,
			DisplayName: "小说文字生成",
			PricingType: "PER_UNIT",
			Rate:        defaultNovelTextResourceRate,
			PerUnits:    defaultNovelTextResourcePerUnits,
			Enabled:     true,
		},
		{
			ResourceKey: defaultArticleWorkflowTextResourceKey,
			DisplayName: "公众号图文生成",
			PricingType: "PER_UNIT",
			Rate:        defaultArticleWorkflowTextResourceRate,
			PerUnits:    defaultArticleWorkflowTextResourcePerUnits,
			Enabled:     true,
		},
		{
			ResourceKey: defaultNovelCoverResourceKey,
			DisplayName: "小说封面生成",
			PricingType: "PER_CALL",
			Rate:        defaultNovelCoverResourceRate,
			PerUnits:    1,
			Enabled:     true,
		},
		{
			ResourceKey: defaultEcomMasterResourceKey,
			DisplayName: "电商长图母版生成",
			PricingType: "PER_UNIT",
			Rate:        defaultEcomMasterResourceRate,
			PerUnits:    1,
			Enabled:     true,
		},
		{
			ResourceKey: defaultEcomMaster1KResourceKey,
			DisplayName: "电商长图母版 1K",
			PricingType: "PER_UNIT",
			Rate:        10,
			PerUnits:    1,
			Enabled:     true,
		},
		{
			ResourceKey: defaultEcomMaster2KResourceKey,
			DisplayName: "电商长图母版 2K",
			PricingType: "PER_UNIT",
			Rate:        20,
			PerUnits:    1,
			Enabled:     true,
		},
		{
			ResourceKey: defaultEcomMaster4KResourceKey,
			DisplayName: "电商长图母版 4K",
			PricingType: "PER_UNIT",
			Rate:        40,
			PerUnits:    1,
			Enabled:     true,
		},
		{
			ResourceKey: defaultEcomSegmentResourceKey,
			DisplayName: "电商长图分段生成",
			PricingType: "PER_UNIT",
			Rate:        defaultEcomSegmentResourceRate,
			PerUnits:    1,
			Enabled:     true,
		},
		{
			ResourceKey: defaultEcomSegment1KResourceKey,
			DisplayName: "电商长图分段 1K",
			PricingType: "PER_UNIT",
			Rate:        10,
			PerUnits:    1,
			Enabled:     true,
		},
		{
			ResourceKey: defaultEcomSegment2KResourceKey,
			DisplayName: "电商长图分段 2K",
			PricingType: "PER_UNIT",
			Rate:        20,
			PerUnits:    1,
			Enabled:     true,
		},
		{
			ResourceKey: defaultEcomSegment4KResourceKey,
			DisplayName: "电商长图分段 4K",
			PricingType: "PER_UNIT",
			Rate:        40,
			PerUnits:    1,
			Enabled:     true,
		},
		{
			ResourceKey: defaultEcomStitchResourceKey,
			DisplayName: "电商长图拼接",
			PricingType: "PER_CALL",
			Rate:        defaultEcomStitchResourceRate,
			PerUnits:    1,
			Enabled:     true,
		},
		{
			ResourceKey: defaultLocalBusinessPromoRender25sResourceKey,
			DisplayName: "本地商家宣传成片生成 25 秒",
			PricingType: "PER_CALL",
			Rate:        25,
			PerUnits:    1,
			Enabled:     true,
		},
		{
			ResourceKey: defaultLocalBusinessPromoRender40sResourceKey,
			DisplayName: "本地商家宣传成片生成 40 秒",
			PricingType: "PER_CALL",
			Rate:        40,
			PerUnits:    1,
			Enabled:     true,
		},
		{
			ResourceKey: defaultLocalBusinessPromoRender60sResourceKey,
			DisplayName: "本地商家宣传成片生成 60 秒",
			PricingType: "PER_CALL",
			Rate:        60,
			PerUnits:    1,
			Enabled:     true,
		},
		{
			ResourceKey: defaultCodexPetV2PackageResourceKey,
			DisplayName: "Codex 桌宠 v2 生图调用",
			PricingType: "PER_UNIT",
			Rate:        defaultCodexPetV2PackageResourceRate,
			PerUnits:    1,
			Enabled:     true,
		},
	}
	defaults = append(defaults, defaultVideoResourcePrices()...)
	for _, row := range defaults {
		var count int64
		if err := s.st.DB.Model(&model.ResourcePrice{}).Where("resource_key = ?", row.ResourceKey).Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			// Only migrate the exact old default. Administratively customized
			// resource prices keep their configured rate and pricing contract.
			if row.ResourceKey == defaultCodexPetV2PackageResourceKey {
				if err := s.st.DB.Model(&model.ResourcePrice{}).
					Where("resource_key = ? AND display_name = ? AND pricing_type = ? AND rate = ? AND per_units = ? AND output_rate = ?",
						defaultCodexPetV2PackageResourceKey,
						"Codex 桌宠 v2 套餐",
						"PER_CALL",
						defaultCodexPetV2PackageResourceRate,
						1,
						0,
					).
					Updates(map[string]any{
						"display_name": "Codex 桌宠 v2 生图调用",
						"pricing_type": "PER_UNIT",
					}).Error; err != nil {
					return err
				}
			}
			continue
		}
		enabled := row.Enabled
		if err := s.st.DB.Create(&row).Error; err != nil {
			return err
		}
		if err := s.st.DB.Model(&model.ResourcePrice{}).Where("resource_key = ?", row.ResourceKey).Update("enabled", enabled).Error; err != nil {
			return err
		}
	}
	return nil
}

type RechargePackage struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	AmountFen int64  `json:"amountFen"`
	Points    int64  `json:"points"`
	Enabled   bool   `json:"enabled"`
	SortOrder int    `json:"sortOrder"`
}

func defaultRechargePackages() []RechargePackage {
	return []RechargePackage{
		{ID: "starter", Name: "入门包", AmountFen: 1900, Points: 1000, Enabled: true, SortOrder: 10},
		{ID: "standard", Name: "标准包", AmountFen: 7900, Points: 5000, Enabled: true, SortOrder: 20},
		{ID: "pro", Name: "进阶包", AmountFen: 25900, Points: 20000, Enabled: true, SortOrder: 30},
		{ID: "max", Name: "大额包", AmountFen: 54900, Points: 50000, Enabled: true, SortOrder: 40},
	}
}

func normalizeRechargePackages(pkgs []RechargePackage) ([]RechargePackage, error) {
	if len(pkgs) > 10 {
		return nil, errors.New("充值套餐最多 10 个")
	}
	out := make([]RechargePackage, 0, len(pkgs))
	seen := map[string]bool{}
	for i, p := range pkgs {
		p.ID = strings.TrimSpace(p.ID)
		p.Name = strings.TrimSpace(p.Name)
		if p.ID == "" {
			p.ID = "pkg_" + strconv.Itoa(i+1)
		}
		if len(p.ID) > 64 {
			return nil, errors.New("套餐 ID 过长")
		}
		if seen[p.ID] {
			return nil, errors.New("套餐 ID 不能重复")
		}
		seen[p.ID] = true
		if p.Name == "" {
			p.Name = "快速充值"
		}
		if len(p.Name) > 64 {
			return nil, errors.New("套餐名称过长")
		}
		if p.AmountFen <= 0 {
			return nil, errors.New("套餐金额须 > 0")
		}
		if p.Points <= 0 {
			return nil, errors.New("套餐算力点须 > 0")
		}
		if p.SortOrder == 0 {
			p.SortOrder = (i + 1) * 10
		}
		out = append(out, p)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].SortOrder == out[j].SortOrder {
			return out[i].AmountFen < out[j].AmountFen
		}
		return out[i].SortOrder < out[j].SortOrder
	})
	return out, nil
}

// RechargeRatio 充值汇率（点/元），缺失返回默认 100。
func (s *Service) RechargeRatio() int64 {
	var c model.PlatformConfig
	if err := s.st.DB.First(&c, "key = ?", rechargeRatioKey).Error; err != nil {
		return defaultRechargeRatio
	}
	n, err := strconv.ParseInt(c.Value, 10, 64)
	if err != nil || n <= 0 {
		return defaultRechargeRatio
	}
	return n
}

// SetRechargeRatio 设置充值汇率（>0）。
func (s *Service) SetRechargeRatio(ratio int64) error {
	if ratio <= 0 {
		return errors.New("汇率须 > 0")
	}
	return s.st.DB.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "key"}},
		DoUpdates: clause.AssignmentColumns([]string{"value"}),
	}).Create(&model.PlatformConfig{Key: rechargeRatioKey, Value: strconv.FormatInt(ratio, 10)}).Error
}

func (s *Service) RechargePackages() []RechargePackage {
	var c model.PlatformConfig
	if err := s.st.DB.First(&c, "key = ?", rechargePackagesKey).Error; err != nil {
		return defaultRechargePackages()
	}
	var pkgs []RechargePackage
	if err := json.Unmarshal([]byte(c.Value), &pkgs); err != nil {
		return defaultRechargePackages()
	}
	normalized, err := normalizeRechargePackages(pkgs)
	if err != nil {
		return defaultRechargePackages()
	}
	return normalized
}

func (s *Service) EnabledRechargePackages() []RechargePackage {
	all := s.RechargePackages()
	out := make([]RechargePackage, 0, len(all))
	for _, p := range all {
		if p.Enabled {
			out = append(out, p)
		}
	}
	return out
}

func (s *Service) FindEnabledRechargePackage(id string) (RechargePackage, bool) {
	id = strings.TrimSpace(id)
	for _, p := range s.EnabledRechargePackages() {
		if p.ID == id {
			return p, true
		}
	}
	return RechargePackage{}, false
}

func (s *Service) SetRechargePackages(pkgs []RechargePackage) error {
	normalized, err := normalizeRechargePackages(pkgs)
	if err != nil {
		return err
	}
	raw, err := json.Marshal(normalized)
	if err != nil {
		return err
	}
	return s.st.DB.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "key"}},
		DoUpdates: clause.AssignmentColumns([]string{"value"}),
	}).Create(&model.PlatformConfig{Key: rechargePackagesKey, Value: string(raw)}).Error
}

// KbDefaultQuota 知识库默认配额（字节），缺失返回默认 1GB。
func (s *Service) KbDefaultQuota() int64 {
	var c model.PlatformConfig
	if err := s.st.DB.First(&c, "key = ?", kbDefaultQuotaKey).Error; err != nil {
		return defaultKbQuotaBytes
	}
	n, err := strconv.ParseInt(c.Value, 10, 64)
	if err != nil || n < 0 {
		return defaultKbQuotaBytes
	}
	return n
}

// SetKbDefaultQuota 设置知识库默认配额（字节，>=0）。
func (s *Service) SetKbDefaultQuota(quota int64) error {
	if quota < 0 {
		return errors.New("配额须 >= 0")
	}
	return s.st.DB.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "key"}},
		DoUpdates: clause.AssignmentColumns([]string{"value"}),
	}).Create(&model.PlatformConfig{Key: kbDefaultQuotaKey, Value: strconv.FormatInt(quota, 10)}).Error
}

// PointsForAmount 按汇率把支付金额(分)换算成算力点：points = amountFen * ratio / 100。
func (s *Service) PointsForAmount(amountFen int64) int64 {
	return amountFen * s.RechargeRatio() / 100
}
