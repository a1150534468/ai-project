package main

import (
	"log"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"ai-assistant-billing/internal/api"
	"ai-assistant-billing/internal/bucket"
	"ai-assistant-billing/internal/config"
	"ai-assistant-billing/internal/membership"
	"ai-assistant-billing/internal/model"
	"ai-assistant-billing/internal/pay"
	"ai-assistant-billing/internal/recon"
	"ai-assistant-billing/internal/registry"
	"ai-assistant-billing/internal/resource"
	"ai-assistant-billing/internal/store"
	"ai-assistant-billing/internal/vip"
	"ai-assistant-billing/internal/wallet"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}
	st, err := store.Open(cfg.DatabaseURL)
	if err != nil {
		log.Fatal(err)
	}
	if err := registry.New(st).SeedDefault(); err != nil {
		log.Fatal(err)
	}
	if err := resource.New(st).EnsureDefaultResourcePrices(); err != nil {
		log.Fatal(err)
	}
	if err := vip.New(st.DB).EnsureDefaultLevels(resource.New(st).RechargeRatio()); err != nil {
		log.Fatal(err)
	}
	w := wallet.New(st)

	// 构造易支付客户端（可选，无配置时为 nil）
	var epay *pay.Epay
	if cfg.EpayPID != "" && cfg.EpayKey != "" && cfg.EpayGateway != "" {
		ep, err := pay.NewEpay(cfg.EpayPID, cfg.EpayKey, cfg.EpayGateway, cfg.CallbackBase)
		if err != nil {
			log.Fatal(err)
		}
		epay = ep
	}

	// 启动对账兜底定时任务：每 5 分钟扫描 10 分钟以上的超时预留并全额退回
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			n := recon.Reconcile(st, w, 10*time.Minute)
			if n > 0 {
				log.Printf("reconcile: refunded %d stale reservations", n)
			}
		}
	}()

	// 每日清扫过期算力点桶（单副本部署，无需分布式锁）
	go func() {
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			if n, err := bucket.SweepExpired(st.DB); err == nil && n > 0 {
				log.Printf("sweep: zeroed %d expired buckets", n)
			}
		}
	}()

	// 周期发点 cron：对齐自然日 0 点触发，实现「旧点 0 点失效、新点 0 点刷新」无缝衔接。
	// GrantPeriod 靠 period_key 唯一键幂等，购买首期已由 ActivateInTx 发放，这里只补后续周期。
	go func() {
		ms := membership.New(st)
		// 给所有 active 会员发放当期点并标记到期会员（幂等，重复调用安全）
		grantDue := func() {
			now := time.Now()
			var actives []model.UserMembership
			st.DB.Where("status = ? AND expires_at > ?", "active", now).Find(&actives)
			for _, m := range actives {
				_ = ms.GrantPeriod(m, now)
			}
			st.DB.Model(&model.UserMembership{}).Where("status = ? AND expires_at <= ?", "active", now).Update("status", "expired")
		}
		grantDue() // 启动即补发当期，防止服务在 0 点后重启导致当天漏发
		for {
			now := time.Now()
			// 下一个「北京时区」自然日 0 点 +5s 缓冲，与发放/过期日界统一（容器时区为 UTC 也正确）
			b := now.In(membership.BeijingLoc)
			next := time.Date(b.Year(), b.Month(), b.Day()+1, 0, 0, 5, 0, membership.BeijingLoc)
			timer := time.NewTimer(next.Sub(now))
			<-timer.C
			grantDue()
		}
	}()

	r := gin.Default()
	log.Printf("billing pricing mode: %s", cfg.PricingMode)
	api.NewWithPricingMode(st, cfg.InternalToken, epay, cfg.PricingMode).Register(r)
	r.GET("/health", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })
	log.Printf("billing listening on :%s", cfg.Port)
	if err := r.Run(":" + cfg.Port); err != nil {
		log.Fatal(err)
	}
}
