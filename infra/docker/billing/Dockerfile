# billing (services/billing): Go 静态编译 → distroless。构建上下文 = services/billing。
# 运行时使用官方 distroless，保持静态二进制镜像最小化并以 nonroot 运行。
FROM golang:1.25-bookworm AS builder
WORKDIR /src
ENV GOPROXY=https://goproxy.cn,direct CGO_ENABLED=0 GOOS=linux
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -trimpath -ldflags="-s -w" -o /billing .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=builder /billing /billing
EXPOSE 8093
ENTRYPOINT ["/billing"]
