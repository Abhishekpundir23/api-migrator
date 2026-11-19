// Synthetic input for the read-only assessment. This file is never executed.
import { Inngest } from "inngest";

const jobs = new Inngest({ id: "inventory-demo" });
jobs.createFunction({ id: "recount" }, { event: "stock/recount" }, async ({ event }) => {
  return event.user;
});
