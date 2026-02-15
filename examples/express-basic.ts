import express from "express";
import { AgentMeter, MemoryTransport } from "../src/index.js";

const app = express();
const transport = new MemoryTransport();

const meter = new AgentMeter({ serviceId: "my-api", transport });
app.use(meter.express());

app.get("/api/widgets", (_req, res) => {
  res.json({ widgets: ["a", "b", "c"] });
});

app.listen(3456, () => {
  console.log("Listening on http://localhost:3456");
  console.log("Try: curl -H 'X-Agent-Id: bot-1' http://localhost:3456/api/widgets");
  console.log("Then check transport.records for the usage record.");
});

// For demo: log records after each request
app.use((_req, _res, next) => {
  setTimeout(() => {
    console.log(`\nRecorded ${transport.records.length} usage record(s):`);
    console.log(JSON.stringify(transport.records.at(-1), null, 2));
  }, 10);
  next();
});
