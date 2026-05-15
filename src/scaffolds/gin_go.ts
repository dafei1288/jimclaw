/**
 * Go Gin Scaffold Provider
 *
 * 为 Go/Gin 项目提供确定性代码模板，避免依赖 LLM 生成基础结构。
 */

import {
  ScaffoldProvider,
  ScaffoldContext,
  registerScaffoldProvider,
} from "./types";

// ── 辅助函数 ──

/** 从 apiContract 推断主要实体名（复数） */
function inferPlural(ctx: ScaffoldContext): string {
  const endpoints = ctx.apiContract?.endpoints || [];
  for (const ep of endpoints) {
    const m = String(ep.path || "").match(/\/api\/([a-z_]+)/i);
    if (m && m[1] !== "health" && m[1] !== "auth") return m[1];
  }
  return "items";
}

function inferSingular(plural: string): string {
  if (plural.endsWith("s")) return plural.slice(0, -1);
  return plural;
}

// ── 模板生成函数 ──

function generateGoMod(ctx: ScaffoldContext): string {
  return `module ${ctx.projectName || "jimclaw-app"}

go 1.21

require github.com/gin-gonic/gin v1.9.1
`;
}

function generateMainGo(ctx: ScaffoldContext): string {
  const port = ctx.port || 4000;
  const plural = inferPlural(ctx);
  const singular = inferSingular(plural);
  const pascalSingular = singular.charAt(0).toUpperCase() + singular.slice(1);

  // 检查是否有 CRUD handler
  const hasCrud = ctx.declaredFiles.has(`handler/${plural}.go`);

  let crudRoutes = "";
  if (hasCrud) {
    crudRoutes = `
	// ${plural} CRUD
	r.GET("/api/${plural}", handler.List${pascalSingular})
	r.GET("/api/${plural}/:id", handler.Get${pascalSingular})
	r.POST("/api/${plural}", handler.Create${pascalSingular})
	r.PUT("/api/${plural}/:id", handler.Update${pascalSingular})
	r.DELETE("/api/${plural}/:id", handler.Delete${pascalSingular})`;
  }

  // 构建 endpoints 列表
  const endpointList = hasCrud
    ? `[]string{"/api/health", "/api/${plural}"}`
    : `[]string{"/api/health"}`;

  return `package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"${ctx.projectName || "jimclaw-app"}/handler"
)

func main() {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())

	// 健康检查
	r.GET("/api/health", handler.HealthCheck)
${crudRoutes}

	// 根路径 - API 导航
	r.GET("/", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"message":   "API Service",
			"version":   "1.0.0",
			"endpoints": ${endpointList},
		})
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "${port}"
	}

	srv := &http.Server{
		Addr:    ":" + port,
		Handler: r,
	}

	go func() {
		log.Printf("Server starting on port %s", port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen: %s\\n", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	log.Println("Shutting down server...")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Fatal("Server forced to shutdown:", err)
	}
	log.Println("Server exited")
}
`;
}

function generateHealthHandler(ctx: ScaffoldContext): string {
  return `package handler

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

// HealthCheck 返回服务健康状态
func HealthCheck(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"status":    "ok",
		"timestamp": time.Now().Format(time.RFC3339),
	})
}
`;
}

function generateHealthTest(ctx: ScaffoldContext): string {
  return `package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestHealthCheck(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/health", HealthCheck)

	req, _ := http.NewRequest(http.MethodGet, "/api/health", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", w.Code)
	}

	body := w.Body.String()
	if body == "" {
		t.Error("response body should not be empty")
	}
}
`;
}

function generateCrudHandler(ctx: ScaffoldContext, plural: string): string {
  const singular = inferSingular(plural);
  const pascalSingular = singular.charAt(0).toUpperCase() + singular.slice(1);

  return `package handler

import (
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// ${pascalSingular} 数据模型
type ${pascalSingular} struct {
	ID        string \`json:"id"\`
	Name      string \`json:"name"\`
	CreatedAt string \`json:"createdAt"\`
	UpdatedAt string \`json:"updatedAt"\`
}

var (
	${plural}Store = make(map[string]*${pascalSingular})
	${plural}Mu    sync.RWMutex
	${plural}Seq   int64
)

func reset${pascalSingular}Store() {
	${plural}Mu.Lock()
	defer ${plural}Mu.Unlock()
	${plural}Store = make(map[string]*${pascalSingular})
	${plural}Seq = 0
}

// List${pascalSingular} 获取列表
func List${pascalSingular}(c *gin.Context) {
	${plural}Mu.RLock()
	defer ${plural}Mu.RUnlock()

	result := make([]*${pascalSingular}, 0, len(${plural}Store))
	for _, item := range ${plural}Store {
		result = append(result, item)
	}
	c.JSON(http.StatusOK, result)
}

// Get${pascalSingular} 获取单个
func Get${pascalSingular}(c *gin.Context) {
	id := c.Param("id")
	${plural}Mu.RLock()
	item, ok := ${plural}Store[id]
	${plural}Mu.RUnlock()
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	c.JSON(http.StatusOK, item)
}

// Create${pascalSingular} 创建
func Create${pascalSingular}(c *gin.Context) {
	var input struct {
		Name string \`json:"name" binding:"required"\`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name is required"})
		return
	}
	${plural}Mu.Lock()
	defer ${plural}Mu.Unlock()
	${plural}Seq++
	now := time.Now().Format(time.RFC3339)
	item := &${pascalSingular}{
		ID:        strconv.FormatInt(${plural}Seq, 10),
		Name:      input.Name,
		CreatedAt: now,
		UpdatedAt: now,
	}
	${plural}Store[item.ID] = item
	c.JSON(http.StatusCreated, item)
}

// Update${pascalSingular} 更新
func Update${pascalSingular}(c *gin.Context) {
	id := c.Param("id")
	var input struct {
		Name string \`json:"name"\`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body"})
		return
	}
	${plural}Mu.Lock()
	defer ${plural}Mu.Unlock()
	item, ok := ${plural}Store[id]
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if input.Name != "" {
		item.Name = input.Name
	}
	item.UpdatedAt = time.Now().Format(time.RFC3339)
	c.JSON(http.StatusOK, item)
}

// Delete${pascalSingular} 删除
func Delete${pascalSingular}(c *gin.Context) {
	id := c.Param("id")
	${plural}Mu.Lock()
	defer ${plural}Mu.Unlock()
	if _, ok := ${plural}Store[id]; !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	delete(${plural}Store, id)
	c.Status(http.StatusNoContent)
}
`;
}

function generateCrudTest(ctx: ScaffoldContext, plural: string): string {
  const singular = inferSingular(plural);
  const pascalSingular = singular.charAt(0).toUpperCase() + singular.slice(1);

  return `package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func setupRouter() *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/${plural}", List${pascalSingular})
	r.GET("/api/${plural}/:id", Get${pascalSingular})
	r.POST("/api/${plural}", Create${pascalSingular})
	r.PUT("/api/${plural}/:id", Update${pascalSingular})
	r.DELETE("/api/${plural}/:id", Delete${pascalSingular})
	return r
}

func Test${pascalSingular}CRUD(t *testing.T) {
	reset${pascalSingular}Store()
	r := setupRouter()

	// Create
	body, _ := json.Marshal(map[string]string{"name": "test-${singular}"})
	req, _ := http.NewRequest(http.MethodPost, "/api/${plural}", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Errorf("create: expected 201, got %d, body=%s", w.Code, w.Body.String())
	}

	// List
	req, _ = http.NewRequest(http.MethodGet, "/api/${plural}", nil)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("list: expected 200, got %d", w.Code)
	}

	// Get
	req, _ = http.NewRequest(http.MethodGet, "/api/${plural}/1", nil)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("get: expected 200, got %d", w.Code)
	}

	// Delete
	req, _ = http.NewRequest(http.MethodDelete, "/api/${plural}/1", nil)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusNoContent {
		t.Errorf("delete: expected 204, got %d", w.Code)
	}
}
`;
}

function generateDockerfile(ctx: ScaffoldContext): string {
  return `FROM golang:1.21-alpine AS builder
WORKDIR /app
COPY go.mod ./
RUN go mod download || true
COPY . .
RUN CGO_ENABLED=0 go build -o server .

FROM alpine:3.18
RUN apk --no-cache add ca-certificates
WORKDIR /app
COPY --from=builder /app/server .
EXPOSE ${ctx.port || 4000}
CMD ["./server"]
`;
}

// ── Provider 实现 ──

class GinGoProvider implements ScaffoldProvider {
  id = "gin-go";
  language = "go";
  frameworks = ["gin", "gin*"];

  canHandle(ctx: ScaffoldContext, normalizedTarget: string): boolean {
    const targets = [
      "go.mod",
      "main.go",
      "dockerfile",
      "handler/health.go",
      "handler/health_test.go",
    ];
    const plural = inferPlural(ctx);
    targets.push(`handler/${plural}.go`, `handler/${plural}_test.go`);
    return targets.includes(normalizedTarget.toLowerCase());
  }

  generate(ctx: ScaffoldContext, normalizedTarget: string): string | null {
    const lower = normalizedTarget.toLowerCase();
    const plural = inferPlural(ctx);

    if (lower === "go.mod") return generateGoMod(ctx);
    if (lower === "main.go") return generateMainGo(ctx);
    if (lower === "dockerfile") return generateDockerfile(ctx);
    if (lower === "handler/health.go") return generateHealthHandler(ctx);
    if (lower === "handler/health_test.go") return generateHealthTest(ctx);
    if (lower === `handler/${plural}.go`) return generateCrudHandler(ctx, plural);
    if (lower === `handler/${plural}_test.go`) return generateCrudTest(ctx, plural);

    return null;
  }

  fileExtensions(): string[] {
    return [".go", ".mod"];
  }

  testCommand(): string {
    return "go test ./... -v";
  }

  runCommand(spec: any, port: number): string {
    return `PORT=${port} go run main.go`;
  }

  baseDockerImage(): string {
    return "golang:1.21-alpine";
  }

  installCommand(): string {
    return "go mod tidy";
  }

  entryFilePath(): string {
    return "main.go";
  }

  testFilePattern(): string {
    return "**/*_test.go";
  }

  priority(): number {
    return 20;
  }
}

// ── 注册 ──
registerScaffoldProvider(new GinGoProvider());
