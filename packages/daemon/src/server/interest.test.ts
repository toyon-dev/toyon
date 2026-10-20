import { describe, expect, test } from "bun:test";
import { Interest } from "./interest.ts";

describe("Interest", () => {
  test("the first subscriber and the last unsubscribe are the two moments it reports", () => {
    const i = new Interest();
    const firsts: string[] = [];
    const lasts: string[] = [];
    i.onFirst((id) => firsts.push(id));
    i.onLast((id) => lasts.push(id));
    const a = {};
    const b = {};
    i.subscribe(a, "wt");
    i.subscribe(b, "wt");
    i.subscribe(a, "wt");
    expect(firsts).toEqual(["wt"]);
    expect(i.isSubscribed("wt")).toBe(true);
    i.unsubscribe(a, "wt");
    expect(lasts).toEqual([]);
    expect(i.isSubscribed("wt")).toBe(true);
    i.unsubscribe(b, "wt");
    expect(lasts).toEqual(["wt"]);
    expect(i.isSubscribed("wt")).toBe(false);
    // a second unsubscribe of a key that holds nothing says nothing
    i.unsubscribe(b, "wt");
    expect(lasts).toEqual(["wt"]);
  });

  test("a socket closing drops every subscription it held, and nobody else's", () => {
    const i = new Interest();
    const lasts: string[] = [];
    i.onLast((id) => lasts.push(id));
    const gone = {};
    const stays = {};
    i.subscribe(gone, "a");
    i.subscribe(gone, "b");
    i.subscribe(stays, "b");
    i.drop(gone);
    expect(lasts).toEqual(["a"]);
    expect(i.subscribed()).toEqual(["b"]);
    expect(i.isSubscribed("b")).toBe(true);
  });
});
