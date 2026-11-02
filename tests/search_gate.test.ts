import { assertEquals } from "jsr:@std/assert";
import { SearchGate } from "../web/search_gate.ts";

Deno.test("phrase searches beyond the slots are refused, not queued (#348)", () => {
  const gate = new SearchGate(2);
  const first = gate.tryAcquire();
  const second = gate.tryAcquire();
  assertEquals(typeof first, "function");
  assertEquals(typeof second, "function");
  assertEquals(gate.tryAcquire(), undefined, "a third finds no slot");

  first!();
  first!();
  assertEquals(gate.inUse, 1, "releasing twice frees one slot, not two");
  assertEquals(typeof gate.tryAcquire(), "function", "a freed slot can be taken again");
});
