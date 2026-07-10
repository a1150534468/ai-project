package vip

import "gorm.io/gorm"

type Service struct{ db *gorm.DB }

func New(db *gorm.DB) *Service { return &Service{db: db} }
