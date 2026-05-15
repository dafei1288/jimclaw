/**
 * React + TypeScript 前端脚手架
 *
 * 用于混合项目（如 React + Java Spring Boot / React + Go Gin / React + Python FastAPI）
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
  if (name.endsWith("s") && name.length > 1) return name.slice(0, -1);
  return name || "item";
}

function hasCrudEntity(ctx: ScaffoldContext): boolean {
  const crudEntities = ctx.requirementProtocol?.capabilities?.crudEntities || [];
  const entities = ctx.requirementProtocol?.capabilities?.entities || [];
  return (crudEntities.length + entities.length) > 0;
}

function normalizeApiResourcePath(rawPath: string): string {
  const normalized = String(rawPath || "").trim().replace(/\/+$/g, "") || "/";
  return normalized
    .replace(/\/:[^/]+(?:\/.*)?$/g, "")
    .replace(/\/\{[^/]+\}(?:\/.*)?$/g, "");
}

function getResourceCapabilities(ctx: ScaffoldContext, plural: string) {
  const fallbackPath = `/api/${plural}`;
  const endpoints = ctx.apiContract?.endpoints || [];
  const resourcePath =
    endpoints
      .map((endpoint: any) => String(endpoint.path || ""))
      .find((endpointPath: string) => normalizeApiResourcePath(endpointPath) === fallbackPath) || fallbackPath;
  const basePath = normalizeApiResourcePath(resourcePath);
  const methods = new Set<string>();
  for (const endpoint of endpoints) {
    if (normalizeApiResourcePath(String(endpoint.path || "")) !== basePath) continue;
    methods.add(String(endpoint.method || "").toUpperCase());
  }
  return {
    resourcePath: basePath,
    supportsCreate: methods.has("POST"),
    supportsUpdate: methods.has("PUT") || methods.has("PATCH"),
    supportsDelete: methods.has("DELETE"),
  };
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
      react: "^19.1.0",
      "react-dom": "^19.1.0",
      "react-router-dom": "^7.5.0",
    },
    devDependencies: {
      "@types/react": "^19.1.0",
      "@types/react-dom": "^19.1.0",
      "@vitejs/plugin-react": "^4.4.0",
      "@testing-library/react": "^16.3.0",
      "@testing-library/jest-dom": "^6.6.3",
      jsdom: "^26.0.0",
      typescript: "~5.7.3",
      vite: "^6.3.2",
      vitest: "^3.1.2",
    },
  }, null, 2);
}

function generateViteConfig(ctx: ScaffoldContext): string {
  const backendPort = ctx.port || 8080;
  return `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
      useDefineForClassFields: true,
      lib: ["ES2020", "DOM", "DOM.Iterable"],
      module: "ESNext",
      skipLibCheck: true,
      moduleResolution: "bundler",
      allowImportingTsExtensions: true,
      isolatedModules: true,
      moduleDetection: "force",
      noEmit: true,
      jsx: "react-jsx",
      strict: true,
      noUnusedLocals: false,
      noUnusedParameters: false,
      noFallthroughCasesInSwitch: true,
    },
    include: ["src"],
  }, null, 2);
}

function generateIndexHtml(ctx: ScaffoldContext): string {
  const title = ctx.projectName || "App";
  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;
}

function generateMainTsx(): string {
  return `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`;
}

function generateApiModule(ctx: ScaffoldContext): string {
  const singular = inferEntitySingular(ctx);
  const plural = inferEntityPlural(ctx);
  const entityCap = singular.charAt(0).toUpperCase() + singular.slice(1);
  const capabilities = getResourceCapabilities(ctx, plural);
  const apiBase = capabilities.resourcePath.replace(new RegExp(`/${plural}$`, "i"), "") || "/api";
  const payloadBlock = capabilities.supportsCreate || capabilities.supportsUpdate
    ? `
export interface Create${entityCap}Payload {
  ${singular === "todo" ? "name: string;" : singular === "article" ? "title: string;\n  content: string;" : "name: string;\n  description?: string;"}
}
`
    : "";
  const createBlock = capabilities.supportsCreate
    ? `

  create: async (data: Create${entityCap}Payload): Promise<${entityCap}> => {
    const res = await fetch(\`\${API_BASE}/${plural}\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(\`Failed to create ${singular}\`);
    return res.json();
  },`
    : "";
  const updateBlock = capabilities.supportsUpdate
    ? `

  update: async (id: string, data: Partial<Create${entityCap}Payload>): Promise<${entityCap}> => {
    const res = await fetch(\`\${API_BASE}/${plural}/\${id}\`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(\`Failed to update ${singular}\`);
    return res.json();
  },`
    : "";
  const deleteBlock = capabilities.supportsDelete
    ? `

  delete: async (id: string): Promise<void> => {
    const res = await fetch(\`\${API_BASE}/${plural}/\${id}\`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) throw new Error(\`Failed to delete ${singular}\`);
  },`
    : "";

  return `const API_BASE = '${apiBase}';

export interface ${entityCap} {
  id: string;
  ${singular === "todo" ? `name: string;
  completed?: boolean;` : singular === "article" ? `title: string;
  content: string;` : `name: string;
  description?: string;`}
  createdAt?: string;
  updatedAt?: string;
}
${payloadBlock}

export const ${singular}Api = {
  list: async (): Promise<${entityCap}[]> => {
    const res = await fetch(\`\${API_BASE}/${plural}\`);
    if (!res.ok) throw new Error(\`Failed to fetch ${plural}\`);
    return res.json();
  },

  get: async (id: string): Promise<${entityCap}> => {
    const res = await fetch(\`\${API_BASE}/${plural}/\${id}\`);
    if (!res.ok) throw new Error(\`Failed to fetch ${singular}\`);
    return res.json();
  },
${createBlock}${updateBlock}${deleteBlock}
};
`;
}

function generateCrudListTsx(ctx: ScaffoldContext): string {
  const singular = inferEntitySingular(ctx);
  const plural = inferEntityPlural(ctx);
  const entityCap = singular.charAt(0).toUpperCase() + singular.slice(1);
  const field = singular === "todo" ? "name" : singular === "article" ? "title" : "name";
  const capabilities = getResourceCapabilities(ctx, plural);

  if (!capabilities.supportsCreate && !capabilities.supportsUpdate && !capabilities.supportsDelete) {
    return `import { useState, useEffect, useCallback } from 'react';
import { ${singular}Api } from '../api';

export default function ${entityCap}List() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchItems = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const data = await ${singular}Api.list();
      setItems(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  return (
    <div style={{ maxWidth: 600, margin: '2rem auto', fontFamily: 'sans-serif' }}>
      <h1>${entityCap} List</h1>
      {error && <p style={{ color: 'red' }}>{error}</p>}
      {loading ? (
        <p>Loading...</p>
      ) : items.length === 0 ? (
        <p>No ${plural} yet.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {items.map((item) => (
            <li key={item.id} style={{ padding: '0.5rem', borderBottom: '1px solid #eee' }}>
              <span>{item.${field}}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
`;
  }

  return `import { useState, useEffect, useCallback } from 'react';
import { ${singular}Api, Create${entityCap}Payload } from '../api';

export default function ${entityCap}List() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [newName, setNewName] = useState('');

  const fetchItems = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const data = await ${singular}Api.list();
      setItems(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    try {
      await ${singular}Api.create({ ${field}: newName.trim() } as Create${entityCap}Payload);
      setNewName('');
      await fetchItems();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await ${singular}Api.delete(id);
      await fetchItems();
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <div style={{ maxWidth: 600, margin: '2rem auto', fontFamily: 'sans-serif' }}>
      <h1>${entityCap} List</h1>

      {error && <p style={{ color: 'red' }}>{error}</p>}

      <div style={{ marginBottom: '1rem', display: 'flex', gap: '0.5rem' }}>
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New ${singular}..."
          onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          style={{ flex: 1, padding: '0.5rem' }}
        />
        <button onClick={handleCreate} style={{ padding: '0.5rem 1rem' }}>
          Add
        </button>
      </div>

      {loading ? (
        <p>Loading...</p>
      ) : items.length === 0 ? (
        <p>No ${plural} yet.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {items.map((item) => (
            <li
              key={item.id}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '0.5rem',
                borderBottom: '1px solid #eee',
              }}
            >
              <span>{item.${field}}</span>
              <button
                onClick={() => handleDelete(item.id)}
                style={{ color: 'red', background: 'none', border: 'none', cursor: 'pointer' }}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
`;
}

function generateAppTsx(ctx: ScaffoldContext): string {
  if (hasCrudEntity(ctx)) {
    const singular = inferEntitySingular(ctx);
    const entityCap = singular.charAt(0).toUpperCase() + singular.slice(1);
    return `import ${entityCap}List from './components/${entityCap}List';

export default function App() {
  return (
    <div>
      <${entityCap}List />
    </div>
  );
}
`;
  }

  return `export default function App() {
  return (
    <div style={{ maxWidth: 600, margin: '2rem auto', fontFamily: 'sans-serif' }}>
      <h1>Welcome</h1>
      <p>Frontend is running. Connect to backend API at /api.</p>
    </div>
  );
}
`;
}

function generateCrudListTest(ctx: ScaffoldContext): string {
  const singular = inferEntitySingular(ctx);
  const entityCap = singular.charAt(0).toUpperCase() + singular.slice(1);
  return `import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import ${entityCap}List from '../${entityCap}List';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

const mockItems = [
  { id: '1', name: 'Test ${singular} 1' },
  { id: '2', name: 'Test ${singular} 2' },
];

describe('${entityCap}List', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockItems),
    });
  });

  it('renders items from API', async () => {
    render(<${entityCap}List />);
    await waitFor(() => {
      expect(screen.getByText('Test ${singular} 1')).toBeInTheDocument();
      expect(screen.getByText('Test ${singular} 2')).toBeInTheDocument();
    });
  });

  it('creates a new item', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockItems) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: '3', name: 'New' }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([...mockItems, { id: '3', name: 'New' }]) });

    render(<${entityCap}List />);
    const input = screen.getByPlaceholderText('New ${singular}...');
    fireEvent.change(input, { target: { value: 'New' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});
`;
}

function generateSetupTest(): string {
  return `import '@testing-library/jest-dom';
`;
}

// ── Scaffold Provider ──

class ReactTypescriptProvider implements ScaffoldProvider {
  id = "react-typescript";
  language = "typescript";
  frameworks = ["react", "react18", "react19"];

  canHandle(_ctx: ScaffoldContext, normalizedTarget: string): boolean {
    const lower = normalizedTarget.toLowerCase();
    return lower.startsWith("frontend/");
  }

  generate(ctx: ScaffoldContext, normalizedTarget: string): string | null {
    const rel = normalizedTarget.replace(/^frontend\//i, "").toLowerCase();

    switch (rel) {
      case "package.json": return generatePackageJson(ctx);
      case "vite.config.ts": return generateViteConfig(ctx);
      case "tsconfig.json": return generateTsConfig();
      case "index.html": return generateIndexHtml(ctx);
      case "src/main.tsx": return generateMainTsx();
      case "src/app.tsx": return generateAppTsx(ctx);
      case "src/api.ts": return generateApiModule(ctx);
      default: {
        // CRUD component files
        if (hasCrudEntity(ctx)) {
          const singular = inferEntitySingular(ctx);
          const entityCap = singular.charAt(0).toUpperCase() + singular.slice(1);
          if (rel === `src/components/${entityCap.toLowerCase()}list.tsx`) return generateCrudListTsx(ctx);
          if (rel === `src/components/__tests__/${entityCap.toLowerCase()}list.test.tsx`) return generateCrudListTest(ctx);
          if (rel === "src/setuptests.ts") return generateSetupTest();
        }
        return null;
      }
    }
  }

  fileExtensions(): string[] {
    return [".tsx", ".ts", ".json", ".html"];
  }

  testCommand(): string {
    return "cd frontend && npx vitest run";
  }

  runCommand(_spec: any, _port: number): string {
    return "echo 'Frontend is served by backend'";
  }

  baseDockerImage(): string {
    return "node:20-alpine";
  }

  installCommand(): string {
    return "cd frontend && npm install --loglevel=error";
  }

  entryFilePath(): string {
    return "frontend/src/main.tsx";
  }

  testFilePattern(): string {
    return "frontend/src/**/*.test.{ts,tsx}";
  }

  priority(): number {
    return 50;
  }
}

registerScaffoldProvider(new ReactTypescriptProvider());

export default new ReactTypescriptProvider();
