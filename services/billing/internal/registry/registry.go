package registry

import (
	"errors"

	"ai-assistant-billing/internal/model"
	"ai-assistant-billing/internal/resource"
	"ai-assistant-billing/internal/store"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// 默认模型 seed（仅在缺失时插入；倍率为占位，运营上线收费前经 admin 调整）。
const defaultModel = "GLM-5.2"
const defaultDisplay = "GLM 5.2"
const defaultModelRatio = 0.002
const defaultCompletionRatio = 1

// 百炼对话助手默认模型。价格取中国内地标准原价（阶梯的 <=256k 档），
// 促销折扣不写入长期计费规则，避免活动结束后倒挂。
const bailianChatModel = "qwen3.7-plus"
const bailianChatDisplay = "Qwen3.7 Plus"
const bailianChatInputRMBPerMillion = 2.0
const bailianChatOutputRMBPerMillion = 8.0
const bailianChatCacheInputRMBPerMillion = 0.4

const embeddingModel = "text-embedding-v4"
const embeddingDisplay = "百炼 Text Embedding V4"
const embeddingModelRatio = 0.00002 // embedding 模型按单位 token 定价，典型比例较小
const embeddingCompletionRatio = 0  // embedding 无输出 token

type Service struct{ st *store.Store }

func New(st *store.Store) *Service { return &Service{st: st} }

type TokenPricing struct {
	InputPricePerMillion       float64
	OutputPricePerMillion      float64
	CacheInputPricePerMillion  float64
	CacheOutputPricePerMillion float64
}

type RMBPricing struct {
	InputPriceRMBPerMillion       float64
	OutputPriceRMBPerMillion      float64
	CacheInputPriceRMBPerMillion  float64
	CacheOutputPriceRMBPerMillion float64
}

var ErrInvalidPricing = errors.New("invalid pricing")
var ErrModelConflict = errors.New("model already exists")

func PricingFromLegacy(modelRatio, completionRatio float64) TokenPricing {
	return TokenPricing{
		InputPricePerMillion:  modelRatio * 1_000_000,
		OutputPricePerMillion: modelRatio * completionRatio * 1_000_000,
	}
}

func legacyRatios(p TokenPricing) (modelRatio, completionRatio float64) {
	if p.InputPricePerMillion <= 0 {
		return 0, 0
	}
	modelRatio = p.InputPricePerMillion / 1_000_000
	return modelRatio, p.OutputPricePerMillion / p.InputPricePerMillion
}

func PricingFromRMB(p RMBPricing, ratio int64) TokenPricing {
	if ratio <= 0 {
		ratio = 100
	}
	pointsPerYuan := float64(ratio)
	return TokenPricing{
		InputPricePerMillion:       p.InputPriceRMBPerMillion * pointsPerYuan,
		OutputPricePerMillion:      p.OutputPriceRMBPerMillion * pointsPerYuan,
		CacheInputPricePerMillion:  p.CacheInputPriceRMBPerMillion * pointsPerYuan,
		CacheOutputPricePerMillion: p.CacheOutputPriceRMBPerMillion * pointsPerYuan,
	}
}

func RMBFromPricing(p TokenPricing, ratio int64) RMBPricing {
	if ratio <= 0 {
		ratio = 100
	}
	pointsPerYuan := float64(ratio)
	return RMBPricing{
		InputPriceRMBPerMillion:       p.InputPricePerMillion / pointsPerYuan,
		OutputPriceRMBPerMillion:      p.OutputPricePerMillion / pointsPerYuan,
		CacheInputPriceRMBPerMillion:  p.CacheInputPricePerMillion / pointsPerYuan,
		CacheOutputPriceRMBPerMillion: p.CacheOutputPricePerMillion / pointsPerYuan,
	}
}

func hasRMBPricing(r model.PriceRule) bool {
	return r.InputPriceRMBPerMillion != 0 || r.OutputPriceRMBPerMillion != 0 ||
		r.CacheInputPriceRMBPerMillion != 0 || r.CacheOutputPriceRMBPerMillion != 0
}

func pricingFromRule(r model.PriceRule) TokenPricing {
	if r.InputPricePerMillion != 0 || r.OutputPricePerMillion != 0 ||
		r.CacheInputPricePerMillion != 0 || r.CacheOutputPricePerMillion != 0 || r.ModelRatio <= 0 {
		return TokenPricing{
			InputPricePerMillion:       r.InputPricePerMillion,
			OutputPricePerMillion:      r.OutputPricePerMillion,
			CacheInputPricePerMillion:  r.CacheInputPricePerMillion,
			CacheOutputPricePerMillion: r.CacheOutputPricePerMillion,
		}
	}
	return PricingFromLegacy(r.ModelRatio, r.CompletionRatio)
}

func rmbFromRule(r model.PriceRule) RMBPricing {
	return RMBPricing{
		InputPriceRMBPerMillion:       r.InputPriceRMBPerMillion,
		OutputPriceRMBPerMillion:      r.OutputPriceRMBPerMillion,
		CacheInputPriceRMBPerMillion:  r.CacheInputPriceRMBPerMillion,
		CacheOutputPriceRMBPerMillion: r.CacheOutputPriceRMBPerMillion,
	}
}

func setRulePricing(r *model.PriceRule, p TokenPricing) {
	r.InputPricePerMillion = p.InputPricePerMillion
	r.OutputPricePerMillion = p.OutputPricePerMillion
	r.CacheInputPricePerMillion = p.CacheInputPricePerMillion
	r.CacheOutputPricePerMillion = p.CacheOutputPricePerMillion
	r.ModelRatio, r.CompletionRatio = legacyRatios(p)
}

func setRuleRMB(r *model.PriceRule, p RMBPricing) {
	r.InputPriceRMBPerMillion = p.InputPriceRMBPerMillion
	r.OutputPriceRMBPerMillion = p.OutputPriceRMBPerMillion
	r.CacheInputPriceRMBPerMillion = p.CacheInputPriceRMBPerMillion
	r.CacheOutputPriceRMBPerMillion = p.CacheOutputPriceRMBPerMillion
}

func normalizePriceRule(r *model.PriceRule, ratio int64) bool {
	backfilledRMB := false
	if !hasRMBPricing(*r) {
		setRuleRMB(r, RMBFromPricing(pricingFromRule(*r), ratio))
		backfilledRMB = true
	}
	setRulePricing(r, PricingFromRMB(rmbFromRule(*r), ratio))
	return backfilledRMB
}

// SeedDefault 幂等：仅当模型不存在时插入，绝不覆盖运营已设值。
func (s *Service) SeedDefault() error {
	ratio := resource.New(s.st).RechargeRatio()
	bailianPricingRMB := RMBPricing{
		InputPriceRMBPerMillion:       bailianChatInputRMBPerMillion,
		OutputPriceRMBPerMillion:      bailianChatOutputRMBPerMillion,
		CacheInputPriceRMBPerMillion:  bailianChatCacheInputRMBPerMillion,
		CacheOutputPriceRMBPerMillion: bailianChatOutputRMBPerMillion,
	}
	bailianPricing := PricingFromRMB(bailianPricingRMB, ratio)
	bailianModelRatio, bailianCompletionRatio := legacyRatios(bailianPricing)
	models := []model.PriceRule{
		{
			Model: bailianChatModel, DisplayName: bailianChatDisplay,
			ModelRatio: bailianModelRatio, CompletionRatio: bailianCompletionRatio,
			InputPricePerMillion: bailianPricing.InputPricePerMillion, OutputPricePerMillion: bailianPricing.OutputPricePerMillion,
			CacheInputPricePerMillion: bailianPricing.CacheInputPricePerMillion, CacheOutputPricePerMillion: bailianPricing.CacheOutputPricePerMillion,
			InputPriceRMBPerMillion: bailianPricingRMB.InputPriceRMBPerMillion, OutputPriceRMBPerMillion: bailianPricingRMB.OutputPriceRMBPerMillion,
			CacheInputPriceRMBPerMillion: bailianPricingRMB.CacheInputPriceRMBPerMillion, CacheOutputPriceRMBPerMillion: bailianPricingRMB.CacheOutputPriceRMBPerMillion,
			Enabled: true,
		},
		{
			Model: defaultModel, DisplayName: defaultDisplay,
			ModelRatio: defaultModelRatio, CompletionRatio: defaultCompletionRatio,
			InputPricePerMillion: defaultModelRatio * 1_000_000, OutputPricePerMillion: defaultModelRatio * defaultCompletionRatio * 1_000_000,
			Enabled: true,
		},
		{
			Model: embeddingModel, DisplayName: embeddingDisplay,
			ModelRatio: embeddingModelRatio, CompletionRatio: embeddingCompletionRatio,
			InputPricePerMillion: embeddingModelRatio * 1_000_000, OutputPricePerMillion: 0,
			Enabled: true,
		},
	}
	for _, m := range models {
		var n int64
		if err := s.st.DB.Model(&model.PriceRule{}).Where("model = ?", m.Model).Count(&n).Error; err != nil {
			return err
		}
		if n == 0 {
			if err := s.st.DB.Model(&model.PriceRule{}).Create(map[string]any{
				"model": m.Model, "display_name": m.DisplayName,
				"model_ratio": m.ModelRatio, "completion_ratio": m.CompletionRatio,
				"input_price_per_million": m.InputPricePerMillion, "output_price_per_million": m.OutputPricePerMillion,
				"cache_input_price_per_million": m.CacheInputPricePerMillion, "cache_output_price_per_million": m.CacheOutputPricePerMillion,
				"input_price_rmb_per_million": m.InputPriceRMBPerMillion, "output_price_rmb_per_million": m.OutputPriceRMBPerMillion,
				"cache_input_price_rmb_per_million": m.CacheInputPriceRMBPerMillion, "cache_output_price_rmb_per_million": m.CacheOutputPriceRMBPerMillion,
				"enabled": m.Enabled,
			}).Error; err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Service) ListAll() ([]model.PriceRule, error) {
	var rows []model.PriceRule
	err := s.st.DB.Order("model asc").Find(&rows).Error
	if err != nil {
		return rows, err
	}
	ratio := resource.New(s.st).RechargeRatio()
	for i := range rows {
		if normalizePriceRule(&rows[i], ratio) {
			if err := s.persistRMBPricing(rows[i]); err != nil {
				return nil, err
			}
		}
	}
	return rows, nil
}

func (s *Service) ListEnabled() ([]model.PriceRule, error) {
	var rows []model.PriceRule
	err := s.st.DB.Where(
		"enabled = ? AND (completion_ratio > 0 OR output_price_per_million > 0 OR cache_output_price_per_million > 0)",
		true,
	).Order("model asc").Find(&rows).Error
	if err != nil {
		return rows, err
	}
	ratio := resource.New(s.st).RechargeRatio()
	for i := range rows {
		if normalizePriceRule(&rows[i], ratio) {
			if err := s.persistRMBPricing(rows[i]); err != nil {
				return nil, err
			}
		}
	}
	return rows, nil
}

// Upsert 新增或整体更新一个模型（含倍率与展示）。
func (s *Service) Upsert(modelName, displayName string, p TokenPricing, enabled bool) error {
	modelRatio, completionRatio := legacyRatios(p)
	rmb := RMBFromPricing(p, resource.New(s.st).RechargeRatio())
	return s.st.DB.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "model"}},
		DoUpdates: clause.AssignmentColumns([]string{"display_name", "model_ratio", "completion_ratio", "input_price_per_million", "output_price_per_million", "cache_input_price_per_million", "cache_output_price_per_million", "input_price_rmb_per_million", "output_price_rmb_per_million", "cache_input_price_rmb_per_million", "cache_output_price_rmb_per_million", "enabled"}),
	}).Model(&model.PriceRule{}).Create(map[string]any{
		"model": modelName, "display_name": displayName,
		"model_ratio": modelRatio, "completion_ratio": completionRatio,
		"input_price_per_million": p.InputPricePerMillion, "output_price_per_million": p.OutputPricePerMillion,
		"cache_input_price_per_million": p.CacheInputPricePerMillion, "cache_output_price_per_million": p.CacheOutputPricePerMillion,
		"input_price_rmb_per_million": rmb.InputPriceRMBPerMillion, "output_price_rmb_per_million": rmb.OutputPriceRMBPerMillion,
		"cache_input_price_rmb_per_million": rmb.CacheInputPriceRMBPerMillion, "cache_output_price_rmb_per_million": rmb.CacheOutputPriceRMBPerMillion,
		"enabled": enabled,
	}).Error
}

func (s *Service) UpsertRMB(modelName, displayName string, p RMBPricing, enabled bool) error {
	if !validRMBPricing(p) {
		return ErrInvalidPricing
	}
	points := PricingFromRMB(p, resource.New(s.st).RechargeRatio())
	modelRatio, completionRatio := legacyRatios(points)
	return s.st.DB.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "model"}},
		DoUpdates: clause.AssignmentColumns([]string{"display_name", "model_ratio", "completion_ratio", "input_price_per_million", "output_price_per_million", "cache_input_price_per_million", "cache_output_price_per_million", "input_price_rmb_per_million", "output_price_rmb_per_million", "cache_input_price_rmb_per_million", "cache_output_price_rmb_per_million", "enabled"}),
	}).Model(&model.PriceRule{}).Create(map[string]any{
		"model": modelName, "display_name": displayName,
		"model_ratio": modelRatio, "completion_ratio": completionRatio,
		"input_price_per_million": points.InputPricePerMillion, "output_price_per_million": points.OutputPricePerMillion,
		"cache_input_price_per_million": points.CacheInputPricePerMillion, "cache_output_price_per_million": points.CacheOutputPricePerMillion,
		"input_price_rmb_per_million": p.InputPriceRMBPerMillion, "output_price_rmb_per_million": p.OutputPriceRMBPerMillion,
		"cache_input_price_rmb_per_million": p.CacheInputPriceRMBPerMillion, "cache_output_price_rmb_per_million": p.CacheOutputPriceRMBPerMillion,
		"enabled": enabled,
	}).Error
}

// UpdatePricing 仅改倍率（PRICING_MANAGE）。
func (s *Service) UpdatePricing(modelName string, p TokenPricing) error {
	modelRatio, completionRatio := legacyRatios(p)
	rmb := RMBFromPricing(p, resource.New(s.st).RechargeRatio())
	res := s.st.DB.Model(&model.PriceRule{}).Where("model = ?", modelName).
		Updates(map[string]any{
			"model_ratio": modelRatio, "completion_ratio": completionRatio,
			"input_price_per_million": p.InputPricePerMillion, "output_price_per_million": p.OutputPricePerMillion,
			"cache_input_price_per_million": p.CacheInputPricePerMillion, "cache_output_price_per_million": p.CacheOutputPricePerMillion,
			"input_price_rmb_per_million": rmb.InputPriceRMBPerMillion, "output_price_rmb_per_million": rmb.OutputPriceRMBPerMillion,
			"cache_input_price_rmb_per_million": rmb.CacheInputPriceRMBPerMillion, "cache_output_price_rmb_per_million": rmb.CacheOutputPriceRMBPerMillion,
		})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

func (s *Service) UpdatePricingRMB(modelName string, p RMBPricing) error {
	if !validRMBPricing(p) {
		return ErrInvalidPricing
	}
	points := PricingFromRMB(p, resource.New(s.st).RechargeRatio())
	modelRatio, completionRatio := legacyRatios(points)
	res := s.st.DB.Model(&model.PriceRule{}).Where("model = ?", modelName).
		Updates(map[string]any{
			"model_ratio": modelRatio, "completion_ratio": completionRatio,
			"input_price_per_million": points.InputPricePerMillion, "output_price_per_million": points.OutputPricePerMillion,
			"cache_input_price_per_million": points.CacheInputPricePerMillion, "cache_output_price_per_million": points.CacheOutputPricePerMillion,
			"input_price_rmb_per_million": p.InputPriceRMBPerMillion, "output_price_rmb_per_million": p.OutputPriceRMBPerMillion,
			"cache_input_price_rmb_per_million": p.CacheInputPriceRMBPerMillion, "cache_output_price_rmb_per_million": p.CacheOutputPriceRMBPerMillion,
		})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

// UpdateDisplay 仅改展示名/开关（MODEL_MANAGE）。
func (s *Service) UpdateDisplay(modelName, displayName string, enabled bool) error {
	res := s.st.DB.Model(&model.PriceRule{}).Where("model = ?", modelName).
		Updates(map[string]any{"display_name": displayName, "enabled": enabled})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

func (s *Service) UpdateIdentity(modelName, newModelName, displayName string, enabled bool) error {
	if modelName == "" || newModelName == "" {
		return gorm.ErrRecordNotFound
	}
	return s.st.DB.Transaction(func(tx *gorm.DB) error {
		if modelName != newModelName {
			var count int64
			if err := tx.Model(&model.PriceRule{}).Where("model = ?", newModelName).Count(&count).Error; err != nil {
				return err
			}
			if count > 0 {
				return ErrModelConflict
			}
		}
		res := tx.Model(&model.PriceRule{}).Where("model = ?", modelName).
			Updates(map[string]any{"model": newModelName, "display_name": displayName, "enabled": enabled})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return gorm.ErrRecordNotFound
		}
		if modelName == newModelName {
			return nil
		}
		return tx.Model(&model.UsageRecord{}).Where("model = ?", modelName).Update("model", newModelName).Error
	})
}

func (s *Service) Delete(modelName string) error {
	res := s.st.DB.Delete(&model.PriceRule{}, "model = ?", modelName)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

func (s *Service) NormalizeAndApply(r *model.PriceRule) error {
	ratio := resource.New(s.st).RechargeRatio()
	if normalizePriceRule(r, ratio) {
		return s.persistRMBPricing(*r)
	}
	return nil
}

func (s *Service) persistRMBPricing(r model.PriceRule) error {
	return s.st.DB.Model(&model.PriceRule{}).Where("model = ?", r.Model).Updates(map[string]any{
		"input_price_rmb_per_million": r.InputPriceRMBPerMillion, "output_price_rmb_per_million": r.OutputPriceRMBPerMillion,
		"cache_input_price_rmb_per_million": r.CacheInputPriceRMBPerMillion, "cache_output_price_rmb_per_million": r.CacheOutputPriceRMBPerMillion,
	}).Error
}

func validRMBPricing(p RMBPricing) bool {
	return p.InputPriceRMBPerMillion >= 0 && p.OutputPriceRMBPerMillion >= 0 &&
		p.CacheInputPriceRMBPerMillion >= 0 && p.CacheOutputPriceRMBPerMillion >= 0
}
