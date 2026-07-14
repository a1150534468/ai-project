package redeem

import (
	"crypto/rand"
	"errors"
	"time"

	"gorm.io/gorm"
	"ai-assistant-billing/internal/model"
)

const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // 去除易混 I/O/0/1
const codeLen = 16

type GenerateArgs struct {
	GrantType    string
	GrantPayload string
	Points       int64
	Count        int
	ExpiresAt    *time.Time
}

type ListFilter struct {
	Status    string // 空=不筛
	GrantType string // 空=不筛
	BatchID   string // 空=不筛
	Limit     int
}

// genCode 生成一个 codeLen 长随机码（crypto/rand）。
func genCode() (string, error) {
	b := make([]byte, codeLen)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	out := make([]byte, codeLen)
	for i, v := range b {
		out[i] = codeAlphabet[int(v)%len(codeAlphabet)]
	}
	return string(out), nil
}

// genBatchID 批次号（用时间戳前缀 + 随机后缀，便于运营筛选；不参与安全）。
func genBatchID() (string, error) {
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	out := make([]byte, 6)
	for i, v := range b {
		out[i] = codeAlphabet[int(v)%len(codeAlphabet)]
	}
	return "B" + time.Now().UTC().Format("20060102") + string(out), nil
}

// Generate 批量生成兑换码；单码唯一冲突自动重试。
func (s *Service) Generate(a GenerateArgs) ([]string, error) {
	if a.Count <= 0 || a.Count > 1000 {
		return nil, errors.New("count 需在 1..1000")
	}
	if a.GrantType == "" {
		a.GrantType = "BALANCE"
	}
	batchID, err := genBatchID()
	if err != nil {
		return nil, err
	}
	codes := make([]string, 0, a.Count)
	err = s.st.DB.Transaction(func(tx *gorm.DB) error {
		for i := 0; i < a.Count; i++ {
			var code string
			// 唯一冲突重试（极低概率）
			for attempt := 0; attempt < 5; attempt++ {
				c, gerr := genCode()
				if gerr != nil {
					return gerr
				}
				rec := model.Redemption{
					Code: c, GrantType: a.GrantType, GrantPayload: a.GrantPayload,
					Points: a.Points, Status: "unused", BatchID: batchID, ExpiresAt: a.ExpiresAt,
				}
				if cerr := tx.Create(&rec).Error; cerr != nil {
					continue // 视为唯一冲突，重试
				}
				code = c
				break
			}
			if code == "" {
				return errors.New("生成兑换码失败：唯一冲突重试耗尽")
			}
			codes = append(codes, code)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return codes, nil
}

func (s *Service) List(f ListFilter) ([]model.Redemption, error) {
	q := s.st.DB.Model(&model.Redemption{})
	if f.Status != "" {
		q = q.Where("status = ?", f.Status)
	}
	if f.GrantType != "" {
		q = q.Where("grant_type = ?", f.GrantType)
	}
	if f.BatchID != "" {
		q = q.Where("batch_id = ?", f.BatchID)
	}
	limit := f.Limit
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	var rows []model.Redemption
	err := q.Order("created_at desc").Limit(limit).Find(&rows).Error
	return rows, err
}

// Disable 停用未使用的码（已使用不可停用）。
func (s *Service) Disable(code string) error {
	res := s.st.DB.Model(&model.Redemption{}).
		Where("code = ? AND status = ?", code, "unused").
		Update("status", "disabled")
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrInvalidCode
	}
	return nil
}
