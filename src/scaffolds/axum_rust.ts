/**
 * Rust Axum Scaffold Provider
 *
 * 为 Rust/Axum 项目提供确定性代码模板。
 * 使用 Cargo + Axum 0.7 + Tokio + Rust 1.75。
 */

import {
  ScaffoldProvider,
  ScaffoldContext,
  registerScaffoldProvider,
} from "./types";

// ── 辅助函数 ──

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

function toPascalCase(s: string): string {
  return s.replace(/(^|_)(\w)/g, (_, _sep, c) => c.toUpperCase());
}

function toSnakeCase(s: string): string {
  return s.replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, "");
}

// ── 模板生成函数 ──

function generateCargoToml(ctx: ScaffoldContext): string {
  const name = (ctx.projectName || "jimclaw-app").replace(/-/g, "_");
  return `[package]
name = "${name}"
version = "1.0.0"
edition = "2021"

[dependencies]
axum = "0.7"
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
chrono = { version = "0.4", features = ["serde"] }
uuid = { version = "1", features = ["v4"] }

[dev-dependencies]
axum-test = "14"
`;
}

function generateMainRs(ctx: ScaffoldContext): string {
  const port = ctx.port || 4000;
  const plural = inferPlural(ctx);
  const singular = inferSingular(plural);
  const pascalSingular = toPascalCase(singular);
  const snakeSingular = toSnakeCase(singular);
  const snakePlural = toSnakeCase(plural);

  const hasCrud = ctx.declaredFiles.has(`src/handlers/${snakePlural}.rs`);

  let modDecl = "";
  let useHandlers = "use handlers::health::health_check;";
  let crudRoutes = "";

  if (hasCrud) {
    useHandlers += `\nuse handlers::${snakePlural}::{create_${snakeSingular}, list_${snakePlural}, get_${snakeSingular}, update_${snakeSingular}, delete_${snakeSingular}};`;
    crudRoutes = `
        .route("/api/${plural}", axum::routing::get(list_${snakePlural}).post(create_${snakeSingular}))
        .route("/api/${plural}/:id", axum::routing::get(get_${snakeSingular}).put(update_${snakeSingular}).delete(delete_${snakeSingular}))`;
  }

  return `use axum::{
    Router,
    routing::get,
    extract::State,
    http::StatusCode,
};
use std::{net::SocketAddr, sync::Arc};

mod handlers;
${modDecl}

${useHandlers}

#[derive(Clone)]
pub struct AppState {
    pub port: u16,
}

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("PORT")
        .unwrap_or_else(|_| "${port}".to_string())
        .parse()
        .unwrap_or(${port});

    let state = Arc::new(AppState { port });

    let app = Router::new()
        .route("/api/health", get(health_check))
        .route("/", get(root))
${crudRoutes}
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    println!("Server starting on port {}", port);
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn root() -> &'static str {
    "API Service"
}
`;
}

function generateHandlersModRs(ctx: ScaffoldContext): string {
  const plural = inferPlural(ctx);
  const snakePlural = toSnakeCase(plural);
  const hasCrud = ctx.declaredFiles.has(`src/handlers/${snakePlural}.rs`);
  let modules = `pub mod health;
`;
  if (hasCrud) modules += `pub mod ${snakePlural};
`;
  return modules;
}

function generateHealthRs(ctx: ScaffoldContext): string {
  return `use axum::{extract::State, Json};
use serde_json::{json, Value};
use std::sync::Arc;
use crate::AppState;

pub async fn health_check(State(_state): State<Arc<AppState>>) -> Json<Value> {
    Json(json!({
        "status": "ok",
        "timestamp": chrono::Utc::now().to_rfc3339()
    }))
}
`;
}

function generateHealthTestRs(ctx: ScaffoldContext): string {
  return `use axum_test::TestServer;
use axum::{
    Router,
    routing::get,
    extract::State,
};
use std::sync::Arc;

mod handlers;

use handlers::health::health_check;

#[derive(Clone)]
struct TestState;

async fn test_app() -> Router {
    Router::new()
        .route("/api/health", get(health_check))
        .with_state(Arc::new(TestState))
}

#[tokio::test]
async fn test_health_check() {
    let server = TestServer::new(test_app().await).unwrap();
    let response = server.get("/api/health").await;
    assert_eq!(response.status_code(), 200);
    let body: serde_json::Value = response.json();
    assert_eq!(body["status"], "ok");
}
`;
}

function generateCrudHandler(ctx: ScaffoldContext, plural: string): string {
  const singular = inferSingular(plural);
  const pascalSingular = toPascalCase(singular);
  const snakeSingular = toSnakeCase(singular);
  const snakePlural = toSnakeCase(plural);

  return `use axum::{
    extract::{Path, State, Json},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use serde_json::{json, Value};
use crate::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ${pascalSingular} {
    pub id: Option<String>,
    pub title: String,
    pub completed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

static STORE: std::sync::LazyLock<Mutex<HashMap<String, ${pascalSingular}>>> = std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
static SEQ: std::sync::LazyLock<Mutex<u64>> = std::sync::LazyLock::new(|| Mutex::new(1));

pub async fn list_${snakePlural}(State(_state): State<Arc<AppState>>) -> Json<Vec<${pascalSingular}>> {
    let store = STORE.lock().unwrap();
    Json(store.values().cloned().collect())
}

pub async fn get_${snakeSingular}(State(_state): State<Arc<AppState>>, Path(id): Path<String>) -> Result<Json<${pascalSingular}>, StatusCode> {
    let store = STORE.lock().unwrap();
    store.get(&id).cloned().map(Json).ok_or(StatusCode::NOT_FOUND)
}

pub async fn create_${snakeSingular}(State(_state): State<Arc<AppState>>, Json(input): Json<${pascalSingular}>) -> (StatusCode, Json<${pascalSingular}>) {
    let mut seq = SEQ.lock().unwrap();
    *seq += 1;
    let id = seq.to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let item = ${pascalSingular} {
        id: Some(id.clone()),
        title: input.title.clone(),
        completed: input.completed,
        created_at: Some(now.clone()),
        updated_at: Some(now),
    };
    STORE.lock().unwrap().insert(id, item.clone());
    (StatusCode::CREATED, Json(item))
}

pub async fn update_${snakeSingular}(State(_state): State<Arc<AppState>>, Path(id): Path<String>, Json(input): Json<${pascalSingular}>) -> Result<Json<${pascalSingular}>, StatusCode> {
    let mut store = STORE.lock().unwrap();
    if let Some(item) = store.get_mut(&id) {
        item.title = input.title.clone();
        if input.completed != item.completed {
            item.completed = input.completed;
        }
        item.updated_at = Some(chrono::Utc::now().to_rfc3339());
        return Ok(Json(item.clone()));
    }
    Err(StatusCode::NOT_FOUND)
}

pub async fn delete_${snakeSingular}(State(_state): State<Arc<AppState>>, Path(id): Path<String>) -> StatusCode {
    let mut store = STORE.lock().unwrap();
    if store.remove(&id).is_some() {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::NOT_FOUND
    }
}
`;
}

function generateCrudTestRs(ctx: ScaffoldContext, plural: string): string {
  const singular = inferSingular(plural);
  const snakeSingular = toSnakeCase(singular);
  const snakePlural = toSnakeCase(plural);

  return `use axum_test::TestServer;
use axum::{Router, routing::{get, post, delete, put}, extract::State};
use std::sync::Arc;
use serde_json::json;

mod handlers;

use handlers::${snakePlural}::*;

fn test_app() -> Router {
    Router::new()
        .route("/api/${plural}", get(list_${snakePlural}).post(create_${snakeSingular}))
        .route("/api/${plural}/:id", get(get_${snakeSingular}).put(update_${snakeSingular}).delete(delete_${snakeSingular}))
        .with_state(Arc::new(()))
}

#[tokio::test]
async fn test_create_and_list_${snakePlural}() {
    let server = TestServer::new(test_app()).unwrap();
    let body = json!({"title": "test-${snakeSingular}", "completed": false});
    let response = server.post("/api/${plural}").json(&body).await;
    assert_eq!(response.status_code(), 201);

    let response = server.get("/api/${plural}").await;
    assert_eq!(response.status_code(), 200);
}
`;
}

function generateDockerfile(ctx: ScaffoldContext): string {
  return `FROM rust:1.75 AS builder
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release || true
COPY . .
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/target/release/${(ctx.projectName || "jimclaw_app").replace(/-/g, "_")} server
EXPOSE ${ctx.port || 4000}
CMD ["./server"]
`;
}

// ── Provider 实现 ──

const AxumRustProvider: ScaffoldProvider = {
  id: "axum-rust",
  language: "rust",
  frameworks: ["axum", "actix", "actix-web", "rocket"],

  canHandle(ctx: ScaffoldContext, normalizedTarget: string): boolean {
    const t = normalizedTarget.toLowerCase();
    return (
      t === "cargo.toml" ||
      t === "dockerfile" ||
      t === "src/main.rs" ||
      t === "src/handlers/mod.rs" ||
      t === "src/handlers/health.rs" ||
      t === "tests/health_test.rs" ||
      t.includes("handlers/") && t.endsWith(".rs") ||
      t.includes("tests/") && t.endsWith(".rs")
    );
  },

  generate(ctx: ScaffoldContext, normalizedTarget: string): string | null {
    const t = normalizedTarget.toLowerCase();
    const plural = inferPlural(ctx);
    const snakePlural = toSnakeCase(plural);

    if (t === "cargo.toml") return generateCargoToml(ctx);
    if (t === "dockerfile") return generateDockerfile(ctx);
    if (t === "src/main.rs") return generateMainRs(ctx);
    if (t === "src/handlers/mod.rs") return generateHandlersModRs(ctx);
    if (t === "src/handlers/health.rs") return generateHealthRs(ctx);
    if (t === "tests/health_test.rs") return generateHealthTestRs(ctx);
    if (t === `src/handlers/${snakePlural}.rs`) return generateCrudHandler(ctx, plural);
    if (t === `tests/${snakePlural}_test.rs`) return generateCrudTestRs(ctx, plural);

    return null;
  },

  fileExtensions(): string[] {
    return [".rs", ".toml"];
  },

  testCommand(spec: any): string {
    return "cargo test -- --nocapture";
  },

  runCommand(spec: any, port: number): string {
    return `PORT=${port} cargo run`;
  },

  baseDockerImage(): string {
    return "rust:1.75";
  },

  installCommand(spec: any): string {
    return "cargo build";
  },

  entryFilePath(spec: any): string {
    return "src/main.rs";
  },

  testFilePattern(): string {
    return "*_test.rs";
  },

  priority(): number {
    return 40;
  },
};

registerScaffoldProvider(AxumRustProvider);

export default AxumRustProvider;
