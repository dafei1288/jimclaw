/**
 * Java Spring Boot Scaffold Provider
 *
 * 为 Java/Spring Boot 项目提供确定性代码模板。
 * 使用 Maven + Spring Boot 3.x + JUnit 5。
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

function toCamelCase(s: string): string {
  const pascal = toPascalCase(s);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

function basePackage(ctx: ScaffoldContext): string {
  return "com.example.app";
}

function pkgPath(ctx: ScaffoldContext): string {
  return `src/main/java/${basePackage(ctx).replace(/\./g, "/")}`;
}

function testPkgPath(ctx: ScaffoldContext): string {
  return `src/test/java/${basePackage(ctx).replace(/\./g, "/")}`;
}

// ── 模板生成函数 ──

function generatePomXml(ctx: ScaffoldContext): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>
    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>3.2.4</version>
        <relativePath/>
    </parent>
    <groupId>com.example</groupId>
    <artifactId>${ctx.projectName || "jimclaw-app"}</artifactId>
    <version>1.0.0</version>
    <name>${ctx.projectName || "jimclaw-app"}</name>

    <properties>
        <java.version>17</java.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-test</artifactId>
            <scope>test</scope>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
            </plugin>
        </plugins>
    </build>
</project>
`;
}

function generateApplicationJava(ctx: ScaffoldContext): string {
  const pkg = basePackage(ctx);
  return `package ${pkg};

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class Application {
    public static void main(String[] args) {
        SpringApplication.run(Application.class, args);
    }
}
`;
}

function generateHealthController(ctx: ScaffoldContext): string {
  const pkg = basePackage(ctx);
  return `package ${pkg};

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.Map;

@RestController
@RequestMapping("/api")
public class HealthController {

    @GetMapping("/health")
    public Map<String, Object> health() {
        return Map.of(
            "status", "ok",
            "timestamp", Instant.now().toString()
        );
    }
}
`;
}

function generateHealthTest(ctx: ScaffoldContext): string {
  const pkg = basePackage(ctx);
  return `package ${pkg};

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.web.servlet.MockMvc;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc
class HealthControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @Test
    void healthEndpointReturns200() throws Exception {
        mockMvc.perform(get("/api/health"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("ok"));
    }
}
`;
}

function generateCrudController(ctx: ScaffoldContext, plural: string): string {
  const pkg = basePackage(ctx);
  const singular = inferSingular(plural);
  const pascalSingular = toPascalCase(singular);
  const camelSingular = toCamelCase(singular);
  const pascalPlural = toPascalCase(plural);

  return `package ${pkg};

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

@RestController
@RequestMapping("/api/${plural}")
public class ${pascalPlural}Controller {

    private final Map<Long, ${pascalSingular}> store = new ConcurrentHashMap<>();
    private final AtomicLong seq = new AtomicLong(1);

    @GetMapping
    public List<${pascalSingular}> list() {
        return new ArrayList<>(store.values());
    }

    @GetMapping("/{id}")
    public ResponseEntity<${pascalSingular}> get(@PathVariable Long id) {
        ${pascalSingular} item = store.get(id);
        if (item == null) return ResponseEntity.notFound().build();
        return ResponseEntity.ok(item);
    }

    @PostMapping
    public ResponseEntity<${pascalSingular}> create(@RequestBody Map<String, Object> body) {
        Long id = seq.getAndIncrement();
        ${pascalSingular} item = new ${pascalSingular}();
        item.id = id;
        item.title = String.valueOf(body.getOrDefault("title", ""));
        item.completed = Boolean.TRUE.equals(body.get("completed"));
        item.createdAt = Instant.now().toString();
        item.updatedAt = item.createdAt;
        store.put(id, item);
        return ResponseEntity.status(HttpStatus.CREATED).body(item);
    }

    @PutMapping("/{id}")
    public ResponseEntity<${pascalSingular}> update(@PathVariable Long id, @RequestBody Map<String, Object> body) {
        ${pascalSingular} item = store.get(id);
        if (item == null) return ResponseEntity.notFound().build();
        if (body.containsKey("title")) item.title = String.valueOf(body.get("title"));
        if (body.containsKey("completed")) item.completed = Boolean.TRUE.equals(body.get("completed"));
        item.updatedAt = Instant.now().toString();
        return ResponseEntity.ok(item);
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable Long id) {
        if (store.remove(id) == null) return ResponseEntity.notFound().build();
        return ResponseEntity.noContent().build();
    }

    public static class ${pascalSingular} {
        public Long id;
        public String title;
        public Boolean completed;
        public String createdAt;
        public String updatedAt;
    }
}
`;
}

function generateCrudTest(ctx: ScaffoldContext, plural: string): string {
  const pkg = basePackage(ctx);
  const pascalPlural = toPascalCase(plural);

  return `package ${pkg};

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc
class ${pascalPlural}ControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @BeforeEach
    void setup() throws Exception {
        // Ensure clean state by creating and deleting all
    }

    @Test
    void createAndGet${toPascalCase(inferSingular(plural))}() throws Exception {
        String body = "{\\"title\\":\\"test\\",\\"completed\\":false}";
        mockMvc.perform(post("/api/${plural}")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.title").value("test"));

        mockMvc.perform(get("/api/${plural}"))
                .andExpect(status().isOk());
    }

    @Test
    void delete${toPascalCase(inferSingular(plural))}() throws Exception {
        String body = "{\\"title\\":\\"to-delete\\",\\"completed\\":false}";
        String response = mockMvc.perform(post("/api/${plural}")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isCreated())
                .andReturn().getResponse().getContentAsString();

        // Extract id from response
        String id = response.replaceAll(".*\\"id\\":(\\\\d+).*", "$1");

        mockMvc.perform(delete("/api/${plural}/" + id))
                .andExpect(status().isNoContent());
    }
}
`;
}

function generateDockerfile(ctx: ScaffoldContext): string {
  return `FROM maven:3.9-eclipse-temurin-17 AS builder
WORKDIR /app
COPY pom.xml .
RUN mvn dependency:go-offline -B
COPY . .
RUN mvn package -DskipTests -B

FROM eclipse-temurin:17-jre-alpine
WORKDIR /app
COPY --from=builder /app/target/*.jar app.jar
EXPOSE ${ctx.port || 4000}
CMD ["java", "-jar", "app.jar"]
`;
}

function generateApplicationProperties(ctx: ScaffoldContext): string {
  const port = ctx.port || 4000;
  return `server.port=${port}
spring.application.name=${ctx.projectName || "jimclaw-app"}
`;
}

// ── Provider 实现 ──

const SpringJavaProvider: ScaffoldProvider = {
  id: "spring-java",
  language: "java",
  frameworks: ["spring boot", "spring", "spring-boot"],

  canHandle(ctx: ScaffoldContext, normalizedTarget: string): boolean {
    const t = normalizedTarget.toLowerCase();
    return (
      t === "pom.xml" ||
      t === "dockerfile" ||
      t.endsWith("application.java") ||
      t.endsWith("application.properties") ||
      t.endsWith("healthcontroller.java") ||
      t.endsWith("healthcontrollertest.java") ||
      t.includes("controller") && t.endsWith(".java") ||
      t.includes("controller") && t.endsWith("test.java")
    );
  },

  generate(ctx: ScaffoldContext, normalizedTarget: string): string | null {
    const t = normalizedTarget.toLowerCase();
    const plural = inferPlural(ctx);

    if (t === "pom.xml") return generatePomXml(ctx);
    if (t === "dockerfile") return generateDockerfile(ctx);
    if (t.endsWith("application.properties")) return generateApplicationProperties(ctx);
    if (t.endsWith("application.java")) return generateApplicationJava(ctx);
    if (t.includes("healthcontrollertest.java")) return generateHealthTest(ctx);
    if (t.includes("healthcontroller.java")) return generateHealthController(ctx);
    if (t.includes("controller") && t.endsWith(".java")) {
      if (t.includes(`${plural}controllertest`)) return generateCrudTest(ctx, plural);
      if (t.includes(`${plural}controller`)) return generateCrudController(ctx, plural);
    }

    return null;
  },

  fileExtensions(): string[] {
    return [".java", ".xml", ".properties"];
  },

  testCommand(spec: any): string {
    return "mvn test -B";
  },

  runCommand(spec: any, port: number): string {
    return `mvn spring-boot:run -Dspring-boot.run.arguments=--server.port=${port}`;
  },

  baseDockerImage(): string {
    return "maven:3.9-eclipse-temurin-17";
  },

  installCommand(spec: any): string {
    return "mvn dependency:go-offline -B";
  },

  entryFilePath(spec: any): string {
    return "src/main/java/com/example/app/Application.java";
  },

  testFilePattern(): string {
    return "*Test.java";
  },

  priority(): number {
    return 30;
  },
};

registerScaffoldProvider(SpringJavaProvider);

export default SpringJavaProvider;
