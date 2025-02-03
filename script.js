/* globals bootstrap */
import sqlite3InitModule from "https://esm.sh/@sqlite.org/sqlite-wasm@3.46.1-build3";
import { render, html } from "https://cdn.jsdelivr.net/npm/lit-html@3/+esm";
import { dsvFormat, autoType } from "https://cdn.jsdelivr.net/npm/d3-dsv@3/+esm";
import { Marked } from "https://cdn.jsdelivr.net/npm/marked@13/+esm";
import { markedHighlight } from "https://cdn.jsdelivr.net/npm/marked-highlight@2/+esm";
import hljs from "https://cdn.jsdelivr.net/npm/highlight.js@11/+esm";
import { Chart, registerables } from "https://cdn.jsdelivr.net/npm/chart.js@4/+esm";

// Initialize SQLite
const defaultDB = "@";
const sqlite3 = await sqlite3InitModule({ printErr: console.error });

// Initialize ChartJS
Chart.register(...registerables);

// Set up DOM elements
const $demos = document.querySelector("#demos");
const $upload = document.getElementById("upload");
const $tablesContainer = document.getElementById("tables-container");
const $sql = document.getElementById("sql");
const $toast = document.getElementById("toast");
const $result = document.getElementById("result");
const toast = new bootstrap.Toast($toast);
const loading = html`<div class="spinner-border" role="status">
  <span class="visually-hidden">Loading...</span>
</div>`;
let completeData;
let latestQueryResult = [];
let latestChart;
let demoIndex = -1;
let demosArray = [];
let data = "";
let generatedSql = "";
let tableHtml = "";
// --------------------------------------------------------------------
// Set up Markdown
const marked = new Marked(
  markedHighlight({
    langPrefix: "hljs language-",
    highlight(code, lang) {
      const language = hljs.getLanguage(lang) ? lang : "plaintext";
      return hljs.highlight(code, { language }).value;
    },
  })
);

marked.use({
  renderer: {
    table(header, body) {
      return `<table class="table table-sm">${header}${body}</table>`;
    },
  },
});

// --------------------------------------------------------------------
// Set up LLM tokens

let token;

try {
  token = (await fetch("https://llmfoundry.straive.com/token", { credentials: "include" }).then((r) => r.json())).token;
} catch {
  token = null;
}

// --------------------------------------------------------------------
// Render demos

async function fetchAndRenderDemos() {
  try {
    // Fetch the configuration file
    const response = await fetch("config.json");
    const { demos } = await response.json();

    // Store the demos array in the global variable
    demosArray = demos;

    // Clear the current demos container
    $demos.innerHTML = "";

    // Render the demos
    render(
      demos.map(
        (demo, index) =>
          html` <div class="col py-3">
            <a
              class="demo card h-100 text-decoration-none mx-2"
              href="${demo.file}"
              data-questions=${JSON.stringify(demo.questions ?? [])}
              data-context=${JSON.stringify(demo.context ?? "")}
              data-index=${index}
            >
              <div class="card-body">
                <h5 class="card-title">${demo.title}</h5>
                <p class="card-text">${demo.body}</p>
              </div>
            </a>
          </div>`
      ),
      $demos
    );
  } catch (error) {
    console.error("Error fetching or rendering demos:", error);
  }
}

$demos.addEventListener("click", async (e) => {
  const $demo = e.target.closest(".demo");
  if ($demo) {
    e.preventDefault();
    const file = $demo.getAttribute("href");
    demoIndex = $demo.getAttribute("data-index");
    render(html`<div class="text-center my-3">${loading}</div>`, $tablesContainer);
    await DB.upload(new File([await fetch(file).then((r) => r.blob())], file.split("/").pop()));
    const questions = JSON.parse($demo.dataset.questions);
    if (questions.length) {
      DB.questionInfo.schema = JSON.stringify(DB.schema());
      DB.questionInfo.questions = questions;
    }
    DB.context = JSON.parse($demo.dataset.context);
    drawTables();
  }
});

// --------------------------------------------------------------------
// Manage database tables
const db = new sqlite3.oo1.DB(defaultDB, "c");
const DB = {
  context: "",

  schema: function () {
    let tables = [];
    db.exec("SELECT name, sql FROM sqlite_master WHERE type='table'", { rowMode: "object" }).forEach((table) => {
      table.columns = db.exec(`PRAGMA table_info(${table.name})`, { rowMode: "object" });
      tables.push(table);
    });
    return tables;
  },

  // Recommended questions for the current schema
  questionInfo: {},
  questions: async function () {
    if (DB.questionInfo.schema !== JSON.stringify(DB.schema())) {
      const response = await llm({
        system: "Suggest 5 diverse, useful questions that a user can answer from this dataset using SQLite",
        user: DB.schema()
          .map(({ sql }) => sql)
          .join("\n\n"),
        schema: {
          type: "object",
          properties: { questions: { type: "array", items: { type: "string" }, additionalProperties: false } },
          required: ["questions"],
          additionalProperties: false,
        },
      });
      if (response.error) DB.questionInfo.error = response.error;
      else DB.questionInfo.questions = response.questions;
      DB.questionInfo.schema = JSON.stringify(DB.schema());
    }
    return DB.questionInfo;
  },

  upload: async function (file) {
    if (file.name.match(/\.(sqlite3|sqlite|db|s3db|sl3)$/i)) await DB.uploadSQLite(file);
    else if (file.name.match(/\.csv$/i)) await DB.uploadDSV(file, ",");
    else if (file.name.match(/\.tsv$/i)) await DB.uploadDSV(file, "\t");
    else notify("danger", `Unknown file type: ${file.name}`);
  },

  uploadSQLite: async function (file) {
    const fileReader = new FileReader();
    await new Promise((resolve) => {
      fileReader.onload = async (e) => {
        await sqlite3.capi.sqlite3_js_posix_create_file(file.name, e.target.result);
        // Copy tables from the uploaded database to the default database
        const uploadDB = new sqlite3.oo1.DB(file.name, "r");
        const tables = uploadDB.exec("SELECT name, sql FROM sqlite_master WHERE type='table'", { rowMode: "object" });
        for (const { name, sql } of tables) {
          db.exec(`DROP TABLE IF EXISTS "${name}"`);
          db.exec(sql);
          const data = uploadDB.exec(`SELECT * FROM "${name}"`, { rowMode: "object" });
          if (data.length > 0) {
            const columns = Object.keys(data[0]);
            const sql = `INSERT INTO "${name}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
            const stmt = db.prepare(sql);
            db.exec("BEGIN TRANSACTION");
            for (const row of data) stmt.bind(columns.map((c) => row[c])).stepReset();
            db.exec("COMMIT");
            stmt.finalize();
          }
        }
        uploadDB.close();
        resolve();
      };
      fileReader.readAsArrayBuffer(file);
    });
    notify("success", "Imported", `Imported SQLite DB: ${file.name}`);
  },

  uploadDSV: async function (file, separator) {
    const fileReader = new FileReader();
    const result = await new Promise((resolve) => {
      fileReader.onload = (e) => {
        const rows = dsvFormat(separator).parse(e.target.result, autoType);
        resolve(rows);
        completeData = rows;
        console.log("Complete Data:", completeData.slice(0, 200));
      };
      fileReader.readAsText(file);
    });
    const tableName = file.name.slice(0, -4).replace(/[^a-zA-Z0-9_]/g, "_");
    await DB.insertRows(tableName, result);
  },

  insertRows: async function (tableName, result) {
    // Create table by auto-detecting column types
    const cols = Object.keys(result[0]);
    const typeMap = Object.fromEntries(
      cols.map((col) => {
        const sampleValue = result[0][col];
        let sqlType = "TEXT";
        if (typeof sampleValue === "number") sqlType = Number.isInteger(sampleValue) ? "INTEGER" : "REAL";
        else if (typeof sampleValue === "boolean") sqlType = "INTEGER"; // SQLite has no boolean
        else if (sampleValue instanceof Date) sqlType = "TEXT"; // Store dates as TEXT
        return [col, sqlType];
      })
    );
    const createTableSQL = `CREATE TABLE IF NOT EXISTS ${tableName} (${cols.map((col) => `[${col}] ${typeMap[col]}`).join(", ")})`;
    db.exec(createTableSQL);

    // Insert data
    const insertSQL = `INSERT INTO ${tableName} (${cols.map((col) => `[${col}]`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
    const stmt = db.prepare(insertSQL);
    db.exec("BEGIN TRANSACTION");
    for (const row of result) {
      stmt
        .bind(
          cols.map((col) => {
            const value = row[col];
            return value instanceof Date ? value.toISOString() : value;
          })
        )
        .stepReset();
    }
    db.exec("COMMIT");
    stmt.finalize();
    notify("success", "Imported", `Imported table: ${tableName}`);
  },
};

$tablesContainer.addEventListener("input", (e) => {
  const $context = e.target.closest("#context");
  if ($context) DB.context = $context.value;
});

// --------------------------------------------------------------------
// Render tables

async function drawTables() {
  const schema = DB.schema();

  const tables = html`
    <div class="accordion narrative mx-auto" id="table-accordion" style="--bs-accordion-btn-padding-y: 0.5rem">
      ${schema.map(
        ({ name, sql, columns }) => html`
          <div class="accordion-item">
            <h2 class="accordion-header">
              <button
                class="accordion-button collapsed"
                type="button"
                data-bs-toggle="collapse"
                data-bs-target="#collapse-${name}"
                aria-expanded="false"
                aria-controls="collapse-${name}"
              >${name}</button>
            </h2>
            <div
              id="collapse-${name}"
              class="accordion-collapse collapse"
              data-bs-parent="#table-accordion"
            >
              <div class="accordion-body">
                <pre style="white-space: pre-wrap">${sql}</pre>
                <table class="table table-striped table-sm">
                  <thead>
                    <tr>
                      <th>Column Name</th>
                      <th>Type</th>
                      <th>Not Null</th>
                      <th>Default Value</th>
                      <th>Primary Key</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${columns.map(
                      (column) => html`
                        <tr>
                          <td>${column.name}</td>
                          <td>${column.type}</td>
                          <td>${column.notnull ? "Yes" : "No"}</td>
                          <td>${column.dflt_value ?? "NULL"}</td>
                          <td>${column.pk ? "Yes" : "No"}</td>
                        </tr>
                      `
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      `
      )}
    </div>
  `;

  const query = () => {
    // Helper function to calculate avg, min, and max for a given column
    const calculateStats = (data, column) => {
      const values = data.map((item) => parseFloat(item[column])).filter((v) => !isNaN(v));
      if (values.length === 0) return { avg: "N/A", min: "N/A", max: "N/A" };

      const sum = values.reduce((acc, val) => acc + val, 0);
      const avg = (sum / values.length).toFixed(2);
      const min = Math.min(...values).toFixed(2);
      const max = Math.max(...values).toFixed(2);

      return { avg, min, max };
    };

    return html`
      <div class="mb-3 narrative mx-auto">
        <h6>Context about Dataset</h6>
        <table class="table table-bordered">
          <thead>
            <tr>
              <th>Columns</th>
              <th>Description</th>
              <th>Average</th>
              <th>Minimum</th>
              <th>Maximum</th>
            </tr>
          </thead>
          <tbody>
            ${Object.entries(demosArray[demoIndex].dict).map(([key, value]) => {
              let stats = { avg: "N/A", min: "N/A", max: "N/A" };
              if (value[1] === "yes") {
                stats = calculateStats(completeData.slice(0, -1), key);
              }
              return html`
                <tr>
                  <td>${key}</td>
                  <td>${value[0]}</td>
                  <td>${stats.avg}</td>
                  <td>${stats.min}</td>
                  <td>${stats.max}</td>
                </tr>
              `;
            })}
          </tbody>
        </table>
      </div>
      <form class="mt-4 narrative mx-auto">
        <div class="mb-3">
          <label for="query" class="form-label fw-bold">Ask a question about your data:</label>
          <textarea class="form-control" name="query" id="query" rows="3"></textarea>
        </div>
        <button type="submit" class="btn btn-primary">Submit</button>
      </form>
    `;
  };

  render([tables, ...(schema.length ? [html`<div class="text-center my-3">${loading}</div>`, query()] : [])], $tablesContainer);
  if (!schema.length) return;

  const $query = $tablesContainer.querySelector("#query");
  $query.scrollIntoView({ behavior: "smooth", block: "center" });
  $query.focus();
  DB.questions().then(({ questions, error }) => {
    if (error) return notify("danger", "Error", JSON.stringify(error));
    render(
      [
        tables,
        html`<div class="mx-auto narrative my-3">
          <h2 class="h6">Sample questions</h2>
          <ul>
            ${questions.map((q) => html`<li><a href="#" class="question">${q}</a></li>`)}
          </ul>
        </div>`,
        query(),
      ],
      $tablesContainer
    );
    $query.focus();
  });
}

// --------------------------------------------------------------------
// Handle chat

$tablesContainer.addEventListener("click", async (e) => {
  const $question = e.target.closest(".question");
  if ($question) {
    e.preventDefault();
    $tablesContainer.querySelector("#query").value = $question.textContent;
    $tablesContainer.querySelector('form button[type="submit"]').click();
  }
});

$tablesContainer.addEventListener("submit", async (e) => {
  e.preventDefault();
  const formData = new FormData(e.target);
  const query = formData.get("query");
  render(html``, $result);
  render(html`<div class="text-center my-3">${loading}</div>`, $sql);
  const result = await llm({
    system: `You are an expert SQLite query writer. The user has a SQLite dataset.

${DB.context}

This is their SQLite schema:

${DB.schema()
  .map(({ sql }) => sql)
  .join("\n\n")}

Answer the user's question following these steps:

1. Guess their objective in asking this.
2. Describe the steps to achieve this objective in SQL.
3. Build the logic for the SQL query by identifying the necessary tables and relationships. Select the appropriate columns based on the user's question and the dataset.
4. Write SQL to answer the question. Use SQLite syntax.
5. Date is in 'dd/mm/yyyyy' format.'
Replace generic filter values (e.g. "a location", "specific region", etc.) by querying a random value from data.
Always use [Table].[Column].
`,
    user: query,
  });

  // Extract everything inside {lang?}...```
  generatedSql = result.match(/```.*?\n(.*?)```/s)?.[1] ?? result;
  console.log("sql", generatedSql);
  try {
    data = db.exec(generatedSql, { rowMode: "object" });
    console.log(data);
    // Render the data using the utility function
    if (data.length > 0) {
      latestQueryResult = data;
      const actions = html`
        <div class="row d-flex align-items-center g-3">
          <div class="col-auto">
            <button id="download-button" type="button" class="btn btn-primary">
              <i class="bi bi-filetype-csv"></i>
              Download CSV
            </button>
          </div>

          <div class="col-auto">
            <button id="sql-button" type="button" class="btn btn-primary">
              <i class="bi bi-filetype-sql"></i>
              Show SQL
            </button>
          </div>

          <div class="col-auto">
            <button id="output-button" type="button" class="btn btn-primary">
              <i class="bi bi-table"></i>
              Show Output
            </button>
          </div>

          <div class="col-auto">
            <button id="chart-button" type="button" class="btn btn-primary">
              <i class="bi bi-bar-chart-line"></i>
              Draw Chart
            </button>
          </div>
        </div>
      `;
      tableHtml = renderTable(data.slice(0, 100));
      render(actions, $sql);
    } else {
      render(html`<p>No results found.</p>`, $sql);
    }
  } catch (e) {
    render(html`<div class="alert alert-danger">${e.message}</div>`, $sql);
    console.error(e);
  }
});

// --------------------------------------------------------------------
// Utilities

function notify(cls, title, message) {
  $toast.querySelector(".toast-title").textContent = title;
  $toast.querySelector(".toast-body").textContent = message;
  const $toastHeader = $toast.querySelector(".toast-header");
  $toastHeader.classList.remove("text-bg-success", "text-bg-danger", "text-bg-warning", "text-bg-info");
  $toastHeader.classList.add(`text-bg-${cls}`);
  toast.show();
}

async function llm({ system, user, schema }) {
  const response = await fetch("https://llmfoundry.straive.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}:datachat` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0,
      ...(schema ? { response_format: { type: "json_schema", json_schema: { name: "response", strict: true, schema } } } : {}),
    }),
  }).then((r) => r.json());
  if (response.error) return response;
  const content = response.choices?.[0]?.message?.content;
  try {
    return schema ? JSON.parse(content) : content;
  } catch (e) {
    return { error: e };
  }
}

// Utility function to render a table
function renderTable(data) {
  const columns = Object.keys(data[0]);
  return html`
    <table class="table table-striped table-hover">
      <thead>
        <tr>
          ${columns.map((col) => html`<th>${col}</th>`)}
        </tr>
      </thead>
      <tbody>
        ${data.map(
          (row) => html`
            <tr>
              ${columns.map((col) => html`<td>${typeof row[col] === 'number' ? row[col].toFixed(2) : row[col]}</td>`)}
            </tr>
          `
        )}
      </tbody>
    </table>
  `;
}

const chartInputBox = () => {
  return html`
    <form>
      <div class="d-flex align-items-center gap-1">
        <input
          type="text"
          id="chart-input"
          name="chart-input"
          class="form-control w-70 "
          placeholder="Describe what you want to chart"
          value="Draw the most appropriate chart to visualize this data"
        />
        <button id="draw-button" class="btn btn-primary w-80" type="submit"><i class="bi bi-pie-chart"></i> Draw</button>
      </div>
    </form>
  `;
};

$sql.addEventListener("click", async (e) => {
  const $downloadButton = e.target.closest("#download-button");
  const $sqlButton = e.target.closest("#sql-button");
  const $outputButton = e.target.closest("#output-button");
  const $chartButton = e.target.closest("#chart-button");

  if ($downloadButton && latestQueryResult.length > 0) {
    download(dsvFormat(",").format(latestQueryResult), "datachat.csv", "text/csv");
  }

  if ($outputButton && latestQueryResult.length > 0) {
    render(tableHtml, $result);
  }

  if ($sqlButton && latestQueryResult.length > 0) {
    render(html`<p>${generatedSql}</p>`, $result);
  }

  if ($chartButton && latestQueryResult.length > 0) {
    render(chartInputBox(), $result);
  }
});

$result.addEventListener("click", async (e) => {
  e.preventDefault();
  const $drawButton = e.target.closest("#draw-button");
  const $chartContainer = document.getElementById("chart-container");

  if ($drawButton && latestQueryResult.length > 0) {
    $chartContainer.innerHTML = `<div class="spinner-border" role="status">
    <span class="visually-hidden">Loading...</span>
  </div>`;

    const system = `Write JS code to draw a ChartJS chart.
  Write the code inside a \`\`\`js code fence.
  \`Chart\` is already imported.
  Data is ALREADY available as \`data\`, an array of objects. Do not create it. Just use it.
  Render inside a <canvas id="chart"> like this:

  \`\`\`js
  return new Chart(
    document.getElementById("chart"),
    {
      type: "...",
      options: { ... },
      data: { ... },
    }
  )
  \`\`\`
  `;
    const user = `
  Question: ${$tablesContainer.querySelector('[name="query"]').value}

  // First 3 rows of result
  data = ${JSON.stringify(latestQueryResult.slice(0, 3))}

  IMPORTANT: ${$result.querySelector("#chart-input").value}
  `;
    const result = await llm({ system, user });
    const code = result.match(/```js\n(.*?)\n```/s)?.[1];
    console.log(result);
    if (!code) {
      notify("danger", "Error", "Could not generate chart code");
      $chartContainer.innerHTML = `<p class="text-danger">Failed to generate chart code.</p>`;
      return;
    }

    $chartContainer.innerHTML = `
    <canvas id="chart"></canvas>
  `;

    try {
      const drawChart = new Function("Chart", "data", code);
      if (latestChart) latestChart.destroy();
      latestChart = drawChart(Chart, latestQueryResult);
    } catch (error) {
      notify("danger", "Error", `Failed to draw chart: ${error.message}`);
      $chartContainer.innerHTML = `<p class="text-danger">Error: ${error.message}</p>`;
      console.error(error);
    }
  }
});

// --------------------------------------------------------------------
// Function to download CSV file
function download(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

// Call the function to fetch and render demos
fetchAndRenderDemos();
