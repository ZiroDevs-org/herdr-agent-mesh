import { describe, expect, test } from "bun:test"
import {
  DELIVERY_STATE,
  type DeliveryState,
  canTransitionDeliveryState,
  validateExplicitScope,
  validateHerdrLocation,
} from "../src/protocol"

describe("Herdr Agent Mesh protocol", () => {
  test("keeps Herdr routing identity separate from descriptive metadata", () => {
    expect(validateHerdrLocation({
      workspace_id: "w1",
      tab_id: "w1:t1",
      pane_id: "w1:p1",
    })).toBeUndefined()
  })

  test("requires an explicit scope shape", () => {
    expect(validateExplicitScope({ kind: "tab", tab_id: "w1:t1" })).toBeUndefined()
    expect(validateExplicitScope({ kind: "workspaces", workspace_ids: ["w1", "w2"] })).toBeUndefined()
    expect(() => validateExplicitScope({ kind: "workspaces", workspace_ids: [] })).toThrow("workspace_ids")
  })

  test("does not treat submission as delivery or processing", () => {
    const submitted = DELIVERY_STATE.SUBMITTED_TO_HERDR as DeliveryState

    expect(submitted).not.toBe(DELIVERY_STATE.DELIVERED)
    expect(submitted).not.toBe(DELIVERY_STATE.PROCESSED)
    expect(canTransitionDeliveryState(submitted, DELIVERY_STATE.OBSERVED)).toBe(true)
    expect(canTransitionDeliveryState(submitted, DELIVERY_STATE.PROCESSED)).toBe(false)
  })
})
