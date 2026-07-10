# billing (services/billing): Go 静态编译 → distroless。构建上下文 = services/billing。
# 基础镜像走 daocloud gcr 镜像（gcr.io 在国内不可达，i/o timeout）。
FROM golang:1.25-bookworm AS builder
WORKDIR /src
ENV GOPROXY=https://goproxy.cn,direct CGO_ENABLED=0 GOOS=linux
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -trimpath -ldflags="-s -w" -o /billing .

FROM gcr.m.daocloud.io/distroless/static-debian12:nonroot
COPY --from=builder /billing /billing
EXPOSE 8093
ENTRYPOINT ["/billing"]
