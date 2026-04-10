/**
 * FastAPI + Python Scaffold Provider
 *
 * 为 Python FastAPI 项目生成确定性 scaffold 代码。
 * 目录结构:
 *   app/
 *     main.py          — FastAPI 入口
 *     models.py        — Pydantic 模型
 *     routers/         — 路由模块
 *     services/        — 业务逻辑
 *   tests/
 *     test_*.py        — pytest 测试
 *   requirements.txt   — 依赖
 *   Dockerfile         — 容器构建
 */

import * as path from "path";
import type { ScaffoldProvider, ScaffoldContext } from "./types";

// ── 工具函数 ──

function toPascalCase(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, ch) => String(ch || "").toUpperCase())
    .replace(/^[a-z]/, (ch) => ch.toUpperCase());
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([A-Z])/g, "_$1")
    .toLowerCase()
    .replace(/^_/, "")
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/_$/g, "");
}

function singularizeStem(value: string): string {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "item";
  if (normalized.endsWith("ies")) return normalized.slice(0, -3) + "y";
  if (normalized.endsWith("ses")) return normalized.slice(0, -2);
  if (normalized.endsWith("s") && normalized.length > 1) return normalized.slice(0, -1);
  return normalized;
}

function extractEntityStemFromRoute(routeFile: string): string {
  const base = path.posix.basename(routeFile, path.posix.extname(routeFile));
  return singularizeStem(base.replace(/s$/, ""));
}

// ── Scaffold 生成函数 ──

function buildRequirementsTxt(ctx: ScaffoldContext): string {
  const deps: string[] = [
    "fastapi>=0.104.0",
    "uvicorn[standard]>=0.24.0",
    "pydantic>=2.0.0",
  ];
  if (ctx.hasAuth) {
    deps.push("python-jose[cryptography]>=3.3.0");
    deps.push("passlib[bcrypt]>=1.7.4");
    deps.push("python-multipart>=0.0.6");
    deps.push("bcrypt>=4.0.0");
  }
  // 测试依赖
  deps.push("");
  deps.push("# dev");
  deps.push("pytest>=7.4.0");
  deps.push("httpx>=0.25.0");
  deps.push("pytest-asyncio>=0.21.0");
  return deps.join("\n") + "\n";
}

function buildPytestIni(): string {
  return `[pytest]
testpaths = tests
`;
}

function buildDockerfilePython(ctx: ScaffoldContext): string {
  return `FROM python:3.11

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE ${ctx.port}

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "${ctx.port}"]
`;
}

function buildFastApiEntry(ctx: ScaffoldContext): string {
  const routeImports = ctx.routeFiles
    .filter((f) => !/health/i.test(f))
    .map((f) => {
      const base = path.posix.basename(f, path.posix.extname(f));
      const stem = singularizeStem(base);
      const moduleName = `app.routers.${stem}`;
      const routerVar = `${stem}_router`;
      return { moduleName, routerVar, stem };
    });

  const hasHealth = ctx.hasHealthRoute;

  const importLines = [
    `from fastapi import FastAPI`,
    `from fastapi.middleware.cors import CORSMiddleware`,
    ...(hasHealth ? [`from app.routers.health import router as health_router`] : []),
    ...routeImports.map((r) => `from ${r.moduleName} import router as ${r.routerVar}`),
  ].join("\n");

  const mountLines = [
    ...(hasHealth ? [`app.include_router(health_router, prefix="/api/health", tags=["health"])`] : []),
    ...routeImports.map((r) => {
      const prefix = r.stem === "auth" ? "/api/auth" : `/api/${r.stem}`;
      return `app.include_router(${r.routerVar}, prefix="${prefix}", tags=["${r.stem}"])`;
    }),
  ].join("\n");

  const healthFallback = hasHealth
    ? ""
    : `
@app.get("/api/health")
async def health_check():
    return {"success": True, "status": "ok"}

@app.get("/api/health/ping")
async def ping():
    return {"success": True, "message": "pong"}
`;

  return `${importLines}

app = FastAPI(title="${ctx.description}", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

${mountLines}
${healthFallback}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=${ctx.port})
`;
}

function buildFastApiHealthRouter(): string {
  return `from fastapi import APIRouter

router = APIRouter()

@router.get("")
async def health_check():
    return {"success": True, "status": "ok"}

@router.get("/ping")
async def ping():
    return {"success": True, "message": "pong"}
`;
}

function buildFastApiCrudRouter(entityStem: string, ctx: ScaffoldContext): string {
  const Pascal = toPascalCase(entityStem);
  const snake = toSnakeCase(entityStem);
  const hasService = ctx.declaredFiles.has(`app/services/${snake}_service.py`);

  const serviceImport = hasService
    ? `from app.services.${snake}_service import (list_${snake}s, get_${snake}, create_${snake}, update_${snake}, delete_${snake})`
    : "";

  // 如果没有 service 文件，内联 CRUD
  const inlineModel = `
from pydantic import BaseModel
from typing import Optional
import uuid
from datetime import datetime

class ${Pascal}(BaseModel):
    id: str
    name: str
    description: str = ""
    created_at: str = ""
    updated_at: str = ""

class ${Pascal}Create(BaseModel):
    name: str
    description: str = ""

class ${Pascal}Update(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None

_store: dict[str, ${Pascal}] = {}

def _seed():
    if not _store:
        now = datetime.now().isoformat()
        _store["demo-${snake}-001"] = ${Pascal}(
            id="demo-${snake}-001",
            name="示例${Pascal}",
            description="示例数据",
            created_at=now,
            updated_at=now,
        )

_seed()
`;

  const crudOps = hasService
    ? `
@router.get("")
async def list_all():
    return await list_${snake}s()

@router.get("/{item_id}")
async def get_one(item_id: str):
    item = await get_${snake}(item_id)
    if not item:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="${Pascal} not found")
    return item

@router.post("", status_code=201)
async def create_one(data: ${Pascal}Create):
    return await create_${snake}(data)

@router.put("/{item_id}")
async def update_one(item_id: str, data: ${Pascal}Update):
    item = await update_${snake}(item_id, data)
    if not item:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="${Pascal} not found")
    return item

@router.delete("/{item_id}", status_code=204)
async def delete_one(item_id: str):
    await delete_${snake}(item_id)
`
    : `
@router.get("")
async def list_all():
    return list(_store.values())

@router.get("/{item_id}")
async def get_one(item_id: str):
    item = _store.get(item_id)
    if not item:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="${Pascal} not found")
    return item

@router.post("", status_code=201)
async def create_one(data: ${Pascal}Create):
    now = datetime.now().isoformat()
    item = ${Pascal}(
        id=str(uuid.uuid4()),
        name=data.name,
        description=data.description,
        created_at=now,
        updated_at=now,
    )
    _store[item.id] = item
    return item

@router.put("/{item_id}")
async def update_one(item_id: str, data: ${Pascal}Update):
    item = _store.get(item_id)
    if not item:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="${Pascal} not found")
    updated = item.model_copy(update={
        **{k: v for k, v in data.model_dump(exclude_unset=True).items() if v is not None},
        "updated_at": datetime.now().isoformat(),
    })
    _store[item_id] = updated
    return updated

@router.delete("/{item_id}", status_code=204)
async def delete_one(item_id: str):
    if item_id in _store:
        del _store[item_id]
`;

  return `from fastapi import APIRouter
${hasService ? serviceImport : inlineModel}

router = APIRouter()
${crudOps}
`;
}

function buildFastApiAuthRouter(): string {
  return `from fastapi import APIRouter, HTTPException, Depends, status
from pydantic import BaseModel
from typing import Optional
import uuid
from datetime import datetime, timedelta
import hashlib
import secrets

router = APIRouter()

# ── 简易内存存储 ──
_users: dict[str, dict] = {}
_tokens: dict[str, str] = {}  # token -> user_id

class RegisterRequest(BaseModel):
    username: str
    password: str
    email: Optional[str] = None

class LoginRequest(BaseModel):
    username: str
    password: str

def _hash_password(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()

def _generate_token() -> str:
    return secrets.token_hex(32)

@router.post("/register", status_code=201)
async def register(req: RegisterRequest):
    if req.username in _users:
        raise HTTPException(status_code=409, detail="Username already exists")
    user_id = str(uuid.uuid4())
    _users[req.username] = {
        "id": user_id,
        "username": req.username,
        "password": _hash_password(req.password),
        "email": req.email or "",
        "created_at": datetime.now().isoformat(),
    }
    return {"id": user_id, "username": req.username, "message": "User registered successfully"}

@router.post("/login")
async def login(req: LoginRequest):
    user = _users.get(req.username)
    if not user or user["password"] != _hash_password(req.password):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token = _generate_token()
    _tokens[token] = user["id"]
    return {"token": token, "user_id": user["id"], "username": user["username"}

@router.get("/me")
async def get_me(token: str = ""):
    user_id = _tokens.get(token)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    for u in _users.values():
        if u["id"] == user_id:
            return {"id": u["id"], "username": u["username"], "email": u["email"]}
    raise HTTPException(status_code=401, detail="User not found")
`;
}

function buildFastApiCrudService(entityStem: string): string {
  const Pascal = toPascalCase(entityStem);
  const snake = toSnakeCase(entityStem);
  return `from pydantic import BaseModel
from typing import Optional
import uuid
from datetime import datetime

class ${Pascal}(BaseModel):
    id: str
    name: str
    description: str = ""
    created_at: str = ""
    updated_at: str = ""

class ${Pascal}Create(BaseModel):
    name: str
    description: str = ""

class ${Pascal}Update(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None

_store: dict[str, ${Pascal}] = {}

def _seed():
    if not _store:
        now = datetime.now().isoformat()
        _store["demo-${snake}-001"] = ${Pascal}(
            id="demo-${snake}-001",
            name="示例${Pascal}",
            description="示例数据",
            created_at=now,
            updated_at=now,
        )

_seed()

async def list_${snake}s() -> list[${Pascal}]:
    return list(_store.values())

async def get_${snake}(item_id: str) -> ${Pascal} | None:
    return _store.get(item_id)

async def create_${snake}(data: ${Pascal}Create) -> ${Pascal}:
    now = datetime.now().isoformat()
    item = ${Pascal}(
        id=str(uuid.uuid4()),
        name=data.name,
        description=data.description,
        created_at=now,
        updated_at=now,
    )
    _store[item.id] = item
    return item

async def update_${snake}(item_id: str, data: ${Pascal}Update) -> ${Pascal} | None:
    item = _store.get(item_id)
    if not item:
        return None
    updated = item.model_copy(update={
        **{k: v for k, v in data.model_dump(exclude_unset=True).items() if v is not None},
        "updated_at": datetime.now().isoformat(),
    })
    _store[item_id] = updated
    return updated

async def delete_${snake}(item_id: str) -> bool:
    if item_id in _store:
        del _store[item_id]
        return True
    return False
`;
}

function buildFastApiTestFile(ctx: ScaffoldContext, testTarget: string): string {
  // 提取测试目标
  const match = testTarget.match(/tests\/test_(.+)\.py$/);
  if (!match) return buildFastApiHealthTest(ctx);

  const entityName = match[1];
  const snake = toSnakeCase(entityName);
  const stem = singularizeStem(entityName);

  if (stem === "health" || entityName === "health") {
    return buildFastApiHealthTest(ctx);
  }

  if (stem === "auth" || entityName === "auth") {
    return buildFastApiAuthTest(ctx);
  }

  // 通用 CRUD 测试
  const apiBase = stem === "auth" ? "/api/auth" : `/api/${stem}`;
  return `import pytest
from httpx import AsyncClient, ASGITransport
from app.main import app

@pytest.fixture
def anyio_backend():
    return "asyncio"

@pytest.mark.anyio
async def test_list_${snake}s():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("${apiBase}")
        assert response.status_code == 200
        assert isinstance(response.json(), list)

@pytest.mark.anyio
async def test_create_${snake}():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("${apiBase}", json={"name": "测试${toPascalCase(stem)}", "description": "测试描述"})
        assert response.status_code == 201
        data = response.json()
        assert data["name"] == "测试${toPascalCase(stem)}"
        assert "id" in data

@pytest.mark.anyio
async def test_get_${snake}():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        # 创建一个
        create_resp = await client.post("${apiBase}", json={"name": "测试"})
        assert create_resp.status_code == 201
        item_id = create_resp.json()["id"]
        # 获取
        response = await client.get(f"${apiBase}/{item_id}")
        assert response.status_code == 200
        assert response.json()["id"] == item_id

@pytest.mark.anyio
async def test_health():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/health")
        assert response.status_code == 200
        assert response.json()["status"] == "ok"
`;
}

function buildFastApiHealthTest(ctx: ScaffoldContext): string {
  return `import pytest
from httpx import AsyncClient, ASGITransport
from app.main import app

@pytest.fixture
def anyio_backend():
    return "asyncio"

@pytest.mark.anyio
async def test_health():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"

@pytest.mark.anyio
async def test_ping():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/health/ping")
        assert response.status_code == 200
        assert response.json()["message"] == "pong"
`;
}

function buildFastApiAuthTest(ctx: ScaffoldContext): string {
  return `import pytest
from httpx import AsyncClient, ASGITransport
from app.main import app

@pytest.fixture
def anyio_backend():
    return "asyncio"

@pytest.mark.anyio
async def test_register():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/api/auth/register", json={
            "username": "testuser",
            "password": "testpass123",
        })
        assert response.status_code == 201
        assert "id" in response.json()

@pytest.mark.anyio
async def test_register_duplicate():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await client.post("/api/auth/register", json={"username": "dupuser", "password": "pass"})
        response = await client.post("/api/auth/register", json={"username": "dupuser", "password": "pass"})
        assert response.status_code == 409

@pytest.mark.anyio
async def test_login():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await client.post("/api/auth/register", json={"username": "loginuser", "password": "pass123"})
        response = await client.post("/api/auth/login", json={"username": "loginuser", "password": "pass123"})
        assert response.status_code == 200
        assert "token" in response.json()

@pytest.mark.anyio
async def test_login_invalid():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/api/auth/login", json={"username": "nouser", "password": "wrong"})
        assert response.status_code == 401

@pytest.mark.anyio
async def test_health():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/health")
        assert response.status_code == 200
`;
}

function buildFastApiInitPy(): string {
  return `# FastAPI 应用包
`;
}

// ── Provider 类 ──

class FastApiPythonProvider implements ScaffoldProvider {
  id = "fastapi-python";
  language = "python";
  frameworks = ["fastapi", "*"]; // fallback for any Python framework

  canHandle(ctx: ScaffoldContext, normalizedTarget: string): boolean {
    // Python 项目文件
    return normalizedTarget.endsWith(".py") ||
      normalizedTarget === "requirements.txt" ||
      normalizedTarget === "Dockerfile" ||
      normalizedTarget === "pytest.ini" ||
      normalizedTarget === "conftest.py" ||
      normalizedTarget.endsWith(".toml");
  }

  generate(ctx: ScaffoldContext, normalizedTarget: string): string | null {
    // requirements.txt
    if (normalizedTarget === "requirements.txt") {
      return buildRequirementsTxt(ctx);
    }

    // pytest.ini
    if (normalizedTarget === "pytest.ini") {
      return buildPytestIni();
    }

    // conftest.py
    if (normalizedTarget === "conftest.py") {
      return [
        "import pytest",
        "from starlette.testclient import TestClient",
        "",
        "from app.main import app",
        "",
        "",
        "@pytest.fixture",
        "def client():",
        "    \"\"\"提供同步 HTTP 测试客户端，基于 Starlette TestClient 直接调用 FastAPI 应用。\"\"\"",
        "    return TestClient(app)",
        "",
      ].join("\n");
    }

    // Dockerfile
    if (normalizedTarget === "Dockerfile" || normalizedTarget === "docker-compose.yml") {
      if (normalizedTarget === "Dockerfile") return buildDockerfilePython(ctx);
      return null; // docker-compose 不生成
    }

    // __init__.py
    if (normalizedTarget.endsWith("__init__.py")) {
      return buildFastApiInitPy();
    }

    // app/main.py — FastAPI 入口
    if (normalizedTarget === "app/main.py") {
      return buildFastApiEntry(ctx);
    }

    // app/models.py
    if (normalizedTarget === "app/models.py") {
      return `from pydantic import BaseModel\nfrom typing import Optional\nfrom datetime import datetime\n`;
    }

    // health router
    if (normalizedTarget === "app/routers/health.py") {
      return buildFastApiHealthRouter();
    }

    // auth router
    if (normalizedTarget === "app/routers/auth.py") {
      return buildFastApiAuthRouter();
    }

    // CRUD router
    const routerMatch = normalizedTarget.match(/^app\/routers\/(.+)\.py$/);
    if (routerMatch) {
      const stem = singularizeStem(routerMatch[1]);
      return buildFastApiCrudRouter(stem, ctx);
    }

    // CRUD service
    const serviceMatch = normalizedTarget.match(/^app\/services\/(.+)_service\.py$/);
    if (serviceMatch) {
      const stem = singularizeStem(serviceMatch[1]);
      return buildFastApiCrudService(stem);
    }

    // test files
    if (normalizedTarget.startsWith("tests/test_") && normalizedTarget.endsWith(".py")) {
      return buildFastApiTestFile(ctx, normalizedTarget);
    }

    // 其他 Python 文件：生成空模块
    if (normalizedTarget.endsWith(".py")) {
      return `# ${normalizedTarget}\n`;
    }

    return null;
  }

  fileExtensions(): string[] {
    return [".py"];
  }

  testCommand(_spec: any): string {
    return "pytest -v";
  }

  runCommand(_spec: any, port: number): string {
    return `uvicorn app.main:app --host 0.0.0.0 --port ${port}`;
  }

  baseDockerImage(): string {
    return "python:3.11";
  }

  installCommand(_spec: any): string {
    return "pip install --no-cache-dir -r requirements.txt";
  }

  entryFilePath(_spec: any): string {
    return "app/main.py";
  }

  testFilePattern(): string {
    return "tests/test_*.py";
  }

  priority(): number {
    return 20; // 低于 Express/TS（10），作为 Python 的 fallback
  }
}

const fastApiPythonProvider = new FastApiPythonProvider();
export default fastApiPythonProvider;
