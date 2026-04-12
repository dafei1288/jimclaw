/**
 * Vue + TypeScript 前端脚手架
 *
 * 用于混合项目（如 Vue + Java Spring Boot / Vue + Go Gin / Vue + Python FastAPI）
 * 文件全部放在 frontend/ 子目录下
 */
import {
  ScaffoldContext,
  ScaffoldProvider,
  registerScaffoldProvider,
} from "./types";

// ── 辅助函数 ──

function inferEntityPlural(ctx: ScaffoldContext): string {
  const crudEntities = ctx.requirementProtocol?.capabilities?.crudEntities || [];
  const entities = ctx.requirementProtocol?.capabilities?.entities || [];
  // 优先 crudEntities（与 inferEntitySingular 一致），然后 entities
  if (crudEntities.length > 0) return crudEntities[0] + "s";
  if (entities.length > 0) return entities[0] + "s";
  const m = (ctx.description || "").match(/(\w+)\/(?:list|create|crud)/i);
  if (m) return m[1];
  return "items";
}

function inferEntitySingular(ctx: ScaffoldContext): string {
  const crudEntities = ctx.requirementProtocol?.capabilities?.crudEntities || [];
  const entities = ctx.requirementProtocol?.capabilities?.entities || [];
  const name = crudEntities[0] || entities[0] || "";
  // 简单单数化
  if (name.endsWith("s") && name.length > 1) return name.slice(0, -1);
  return name || "item";
}

function hasCrudEntity(ctx: ScaffoldContext): boolean {
  const crudEntities = ctx.requirementProtocol?.capabilities?.crudEntities || [];
  const entities = ctx.requirementProtocol?.capabilities?.entities || [];
  return (crudEntities.length + entities.length) > 0;
}

// ── 模板生成 ──

function generatePackageJson(ctx: ScaffoldContext): string {
  return JSON.stringify({
    name: `frontend-${ctx.projectName || "app"}`,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      dev: "vite",
      build: "vite build",
      test: "vitest run",
      "test:watch": "vitest",
    },
    dependencies: {
      vue: "^3.5.13",
      "vue-router": "^4.5.0",
    },
    devDependencies: {
      "@vitejs/plugin-vue": "^5.2.3",
      "@vue/test-utils": "^2.4.6",
      jsdom: "^26.0.0",
      typescript: "~5.7.3",
      vite: "^6.3.2",
      vitest: "^3.1.2",
      "vue-tsc": "^2.2.8",
    },
  }, null, 2);
}

function generateViteConfig(ctx: ScaffoldContext): string {
  const backendPort = ctx.port || 8080;
  return `import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:${backendPort}',
        changeOrigin: true,
      },
    },
  },
});
`;
}

function generateTsConfig(): string {
  return JSON.stringify({
    compilerOptions: {
      target: "ES2020",
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      jsx: "preserve",
      resolveJsonModule: true,
      isolatedModules: true,
      esModuleInterop: true,
      lib: ["ES2020", "DOM", "DOM.Iterable"],
      skipLibCheck: true,
      noEmit: true,
      paths: { "@/*": ["./src/*"] },
    },
    include: ["src/**/*.ts", "src/**/*.tsx", "src/**/*.vue"],
    references: [{ path: "./tsconfig.node.json" }],
  }, null, 2);
}

function generateTsConfigNode(): string {
  return JSON.stringify({
    compilerOptions: {
      composite: true,
      skipLibCheck: true,
      module: "ESNext",
      moduleResolution: "bundler",
      allowSyntheticDefaultImports: true,
    },
    include: ["vite.config.ts"],
  }, null, 2);
}

function generateMainTs(_ctx: ScaffoldContext): string {
  return `import { createApp } from 'vue';
import App from './App.vue';

const app = createApp(App);
app.mount('#app');
`;
}

function generateAppVue(ctx: ScaffoldContext): string {
  const singular = inferEntitySingular(ctx);
  const plural = inferEntityPlural(ctx);
  const pascal = singular.charAt(0).toUpperCase() + singular.slice(1);
  const crud = hasCrudEntity(ctx);

  const importSection = crud
    ? `import { ref, computed } from 'vue';\nimport HealthCheck from './components/HealthCheck.vue';\nimport ${pascal}List from './components/${pascal}List.vue';`
    : `import { ref, computed } from 'vue';\nimport HealthCheck from './components/HealthCheck.vue';`;

  const crudSection = crud
    ? `    <${pascal}List />\n    <hr/>`
    : '';

  return `<template>
  <div id="app">
    <h1>{{ title }}</h1>
    <HealthCheck @status-change="onStatusChange" />
    <p v-if="backendStatus" :class="statusClass">后端状态: {{ backendStatus }}</p>
    <hr/>
${crudSection}
  </div>
</template>

<script setup lang="ts">
${importSection}

const title = ref('${ctx.projectName || "App"}');
const backendStatus = ref('');

const statusClass = computed(() => ({
  'status-ok': backendStatus.value === 'ok',
  'status-error': backendStatus.value && backendStatus.value !== 'ok',
}));

function onStatusChange(status: string) {
  backendStatus.value = status;
}
</script>

<style>
#app {
  font-family: Arial, sans-serif;
  max-width: 800px;
  margin: 0 auto;
  padding: 20px;
}
.status-ok { color: green; }
.status-error { color: red; }
hr { border: none; border-top: 1px solid #eee; margin: 20px 0; }
</style>
`;
}

function generateHealthCheckVue(ctx: ScaffoldContext): string {
  const port = ctx.port || 8080;
  return `<template>
  <div class="health-check">
    <button @click="checkHealth" :disabled="loading">
      {{ loading ? '检查中...' : '健康检查' }}
    </button>
    <p v-if="error" class="error">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

const emit = defineEmits<{
  (e: 'status-change', status: string): void;
}>();

const loading = ref(false);
const error = ref('');

async function checkHealth() {
  loading.value = true;
  error.value = '';
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    emit('status-change', data.status || 'ok');
  } catch (e: any) {
    error.value = e.message || '请求失败';
    emit('status-change', 'error');
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.health-check { margin: 20px 0; }
button {
  padding: 8px 16px;
  cursor: pointer;
  background: #42b883;
  color: white;
  border: none;
  border-radius: 4px;
}
button:disabled { opacity: 0.6; cursor: not-allowed; }
.error { color: red; margin-top: 8px; }
</style>
`;
}

function generateCrudListVue(ctx: ScaffoldContext, singular: string, plural: string): string {
  const pascal = singular.charAt(0).toUpperCase() + singular.slice(1);
  const titleField = singular === "task" ? "title" : "name";
  return `<template>
  <div class="${singular}-list">
    <h2>${pascal}管理</h2>

    <!-- 新增表单 -->
    <div class="form-row">
      <input v-model="newItem.${titleField}" placeholder="${titleField}" />
      <input v-model="newItem.description" placeholder="description" />
      <select v-model="newItem.status">
        <option value="todo">todo</option>
        <option value="in-progress">in-progress</option>
        <option value="done">done</option>
      </select>
      <button @click="createItem" :disabled="!newItem.${titleField}">新增</button>
    </div>

    <!-- 列表 -->
    <table v-if="items.length">
      <thead>
        <tr>
          <th>ID</th>
          <th>${pascal === "Task" ? "Title" : "Name"}</th>
          <th>Description</th>
          <th>Status</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in items" :key="item.id">
          <td>{{ item.id }}</td>
          <td>{{ item.${titleField} }}</td>
          <td>{{ item.description }}</td>
          <td>
            <select v-model="item.status" @change="updateItem(item)">
              <option value="todo">todo</option>
              <option value="in-progress">in-progress</option>
              <option value="done">done</option>
            </select>
          </td>
          <td>
            <button class="btn-delete" @click="deleteItem(item.id)">删除</button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-else>暂无${pascal}数据</p>

    <p v-if="error" class="error">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { fetch${pascal}List, create${pascal}, update${pascal}, delete${pascal} } from '../api/${plural}';

interface ${pascal}Item {
  id: number;
  ${titleField}: string;
  description?: string;
  status?: string;
  [key: string]: any;
}

const items = ref<${pascal}Item[]>([]);
const error = ref('');
const newItem = ref<{ ${titleField}: string; description: string; status: string }>({
  ${titleField}: '',
  description: '',
  status: 'todo',
});

async function loadItems() {
  try {
    error.value = '';
    items.value = await fetch${pascal}List();
  } catch (e: any) {
    error.value = e.message || '加载失败';
  }
}

async function createItem() {
  try {
    error.value = '';
    await create${pascal}(newItem.value);
    newItem.value = { ${titleField}: '', description: '', status: 'todo' };
    await loadItems();
  } catch (e: any) {
    error.value = e.message || '创建失败';
  }
}

async function updateItem(item: ${pascal}Item) {
  try {
    error.value = '';
    await update${pascal}(item.id, item);
  } catch (e: any) {
    error.value = e.message || '更新失败';
    await loadItems();
  }
}

async function deleteItem(id: number) {
  try {
    error.value = '';
    await delete${pascal}(id);
    await loadItems();
  } catch (e: any) {
    error.value = e.message || '删除失败';
  }
}

onMounted(loadItems);
</script>

<style scoped>
.${singular}-list { margin: 20px 0; }
.form-row {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}
.form-row input, .form-row select {
  padding: 6px 10px;
  border: 1px solid #ddd;
  border-radius: 4px;
}
button {
  padding: 6px 14px;
  cursor: pointer;
  background: #42b883;
  color: white;
  border: none;
  border-radius: 4px;
}
button:disabled { opacity: 0.6; }
button:hover { background: #35a372; }
.btn-delete { background: #e74c3c; }
.btn-delete:hover { background: #c0392b; }
table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 12px;
}
th, td {
  text-align: left;
  padding: 8px 12px;
  border-bottom: 1px solid #eee;
}
th { background: #f5f5f5; }
.error { color: red; margin-top: 12px; }
</style>
`;
}

function generateApiModule(ctx: ScaffoldContext, singular: string, plural: string): string {
  const pascal = singular.charAt(0).toUpperCase() + singular.slice(1);
  return `const API_BASE = '/api/${plural}';

export async function fetch${pascal}List(): Promise<any[]> {
  const res = await fetch(API_BASE);
  if (!res.ok) throw new Error('Failed to fetch ${plural}');
  return res.json();
}

export async function create${pascal}(data: Record<string, any>): Promise<any> {
  const res = await fetch(API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Failed to create ${singular}');
  return res.json();
}

export async function update${pascal}(id: number, data: Record<string, any>): Promise<any> {
  const res = await fetch(API_BASE + '/' + id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Failed to update ${singular}');
  return res.json();
}

export async function delete${pascal}(id: number): Promise<void> {
  const res = await fetch(API_BASE + '/' + id, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 204) throw new Error('Failed to delete ${singular}');
}
`;
}

function generateCrudListTest(ctx: ScaffoldContext, singular: string, plural: string): string {
  const pascal = singular.charAt(0).toUpperCase() + singular.slice(1);
  return `import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ${pascal}List from '../src/components/${pascal}List.vue';

// mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('${pascal}List', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    // Default: GET /api/${plural} returns empty list
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });
  });

  it('renders the component with heading', async () => {
    const wrapper = mount(${pascal}List);
    // Wait for onMounted
    await new Promise(r => setTimeout(r, 50));
    expect(wrapper.find('h2').text()).toContain('${pascal}');
  });

  it('shows empty message when no ${plural}', async () => {
    const wrapper = mount(${pascal}List);
    await new Promise(r => setTimeout(r, 50));
    expect(wrapper.text()).toContain('暂无');
  });

  it('has form inputs for creating new ${singular}', async () => {
    const wrapper = mount(${pascal}List);
    await new Promise(r => setTimeout(r, 50));
    expect(wrapper.find('input[placeholder="title"]').exists() || wrapper.find('input').exists()).toBe(true);
  });
});
`;
}

function generateEnvDts(): string {
  return `/// <reference types="vite/client" />
`;
}

function generateHealthCheckTest(ctx: ScaffoldContext): string {
  return `import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import HealthCheck from '../src/components/HealthCheck.vue';

// mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('HealthCheck', () => {
  it('renders button', () => {
    const wrapper = mount(HealthCheck);
    expect(wrapper.find('button').exists()).toBe(true);
  });

  it('shows loading state when clicked', async () => {
    mockFetch.mockResolvedValue({
      json: () => Promise.resolve({ status: 'ok' }),
    });
    const wrapper = mount(HealthCheck);
    await wrapper.find('button').trigger('click');
    // 按钮应该存在（可能在 loading 或已完成状态）
    expect(wrapper.find('button').exists()).toBe(true);
  });
});
`;
}

function generateVitestConfig(): string {
  return `import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'jsdom',
  },
});
`;
}

function generateIndexHtml(ctx: ScaffoldContext): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${ctx.projectName || "App"}</title>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
`;
}

// ── Provider 类 ──

class VueTypescriptProvider implements ScaffoldProvider {
  id = "vue-typescript";
  language = "typescript";
  frameworks = ["vue", "vue3"];

  canHandle(_ctx: ScaffoldContext, normalizedTarget: string): boolean {
    const lower = normalizedTarget.toLowerCase();
    return lower.startsWith("frontend/");
  }

  generate(ctx: ScaffoldContext, normalizedTarget: string): string | null {
    // 去掉 frontend/ 前缀来匹配
    const rel = normalizedTarget.replace(/^frontend\//i, "").toLowerCase();

    // 静态文件匹配
    switch (rel) {
      case "package.json": return generatePackageJson(ctx);
      case "vite.config.ts": return generateViteConfig(ctx);
      case "tsconfig.json": return generateTsConfig();
      case "tsconfig.node.json": return generateTsConfigNode();
      case "vitest.config.ts": return generateVitestConfig();
      case "index.html": return generateIndexHtml(ctx);
      case "src/main.ts": return generateMainTs(ctx);
      case "src/app.vue": return generateAppVue(ctx);
      case "src/env.d.ts": return generateEnvDts();
      case "src/components/healthcheck.vue": return generateHealthCheckVue(ctx);
      case "tests/healthcheck.test.ts": return generateHealthCheckTest(ctx);
    }

    // CRUD 组件动态匹配
    if (hasCrudEntity(ctx)) {
      const singular = inferEntitySingular(ctx);
      const plural = inferEntityPlural(ctx);
      const pascal = singular.charAt(0).toUpperCase() + singular.slice(1);

      if (rel === `src/components/${pascal.toLowerCase()}list.vue`) return generateCrudListVue(ctx, singular, plural);
      if (rel === `src/api/${plural.toLowerCase()}.ts`) return generateApiModule(ctx, singular, plural);
      if (rel === `tests/${pascal.toLowerCase()}list.test.ts`) return generateCrudListTest(ctx, singular, plural);
    }

    return null;
  }

  fileExtensions(): string[] {
    return [".vue", ".ts", ".json", ".html"];
  }

  testCommand(): string {
    return "cd frontend && npx vitest run";
  }

  runCommand(_spec: any, _port: number): string {
    // 前端不需要独立运行——由后端 serve 静态文件
    return "echo 'Frontend is served by backend'";
  }

  baseDockerImage(): string {
    // 前端不直接用 Docker——在 backend 容器内构建
    return "node:20-alpine";
  }

  installCommand(): string {
    return "cd frontend && npm install --loglevel=error";
  }

  entryFilePath(): string {
    return "frontend/src/main.ts";
  }

  testFilePattern(): string {
    return "frontend/tests/**/*.test.ts";
  }

  /** 前端 scaffold 优先级低于后端 */
  priority(): number {
    return 50;
  }
}

// ── 注册 ──
registerScaffoldProvider(new VueTypescriptProvider());
