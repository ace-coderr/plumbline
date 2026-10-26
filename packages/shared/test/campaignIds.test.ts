import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  V2_ID_BASE,
  appIdOf,
  campaignLabel,
  campaignPath,
  campaignSources,
  currentSource,
  hasLegacy,
  parseCampaignParam,
  reportScope,
  resolveCampaign,
  sourceOfAddress,
} from "../src/campaignIds.js";

const legacy = campaignSources[0];
const v2 = currentSource;

describe("campaign ids across two contracts", () => {
  it("the deployment has a legacy v1 and a v2", () => {
    assert.ok(hasLegacy, "the shipped deployment record carries the legacy pair");
    assert.equal(legacy?.version, "v1");
    assert.equal(v2.version, "v2");
    assert.notEqual(legacy?.campaigns.toLowerCase(), v2.campaigns.toLowerCase());
    assert.ok(v2.deployBlock > (legacy?.deployBlock ?? 0));
  });

  it("v1 and v2 campaign number 1 are different ids", () => {
    assert.equal(appIdOf(legacy?.campaigns ?? "", 1), 1);
    assert.equal(appIdOf(v2.campaigns, 1), V2_ID_BASE + 1);
    assert.equal(appIdOf("0x0000000000000000000000000000000000000001", 1), null, "an unknown contract has no ids");
  });

  it("resolves an app id back to its contract and number", () => {
    assert.deepEqual({ a: resolveCampaign(3).source.version, n: resolveCampaign(3).localId }, { a: "v1", n: 3 });
    assert.deepEqual({ a: resolveCampaign(V2_ID_BASE + 7).source.version, n: resolveCampaign(V2_ID_BASE + 7).localId }, { a: "v2", n: 7 });
  });

  it("labels and paths name the version", () => {
    assert.equal(campaignLabel(2), "v1 #2");
    assert.equal(campaignLabel(V2_ID_BASE + 1), "v2 #1");
    assert.equal(campaignLabel("2"), "v1 #2");
    assert.equal(campaignPath(2), "/campaign/2");
    assert.equal(campaignPath(V2_ID_BASE + 4), "/campaign/v2-4");
  });

  it("parses URL parameters and rejects everything else", () => {
    assert.equal(parseCampaignParam("3"), 3);
    assert.equal(parseCampaignParam("v2-3"), V2_ID_BASE + 3);
    for (const bad of ["", "0", "v2-0", "-1", "1.5", "abc", "v3-1", "v2-", "1e3", "0x10", " ", "99999999999", "v2-01"]) {
      assert.equal(parseCampaignParam(bad), null, `"${bad}" is not a campaign`);
    }
  });

  it("round-trips every path through its parser", () => {
    for (const id of [1, 2, 3, 999_999, V2_ID_BASE + 1, V2_ID_BASE + 250]) {
      assert.equal(parseCampaignParam(campaignPath(id).replace("/campaign/", "")), id);
    }
  });

  it("finds a source by address, case-insensitively", () => {
    assert.equal(sourceOfAddress(v2.campaigns.toUpperCase().replace("0X", "0x"))?.version, "v2");
    assert.equal(sourceOfAddress("0x0000000000000000000000000000000000000002"), null);
  });

  it("a report against v2 covers both contracts, one against v1 only v1, anything else nothing", () => {
    assert.deepEqual(reportScope(v2.campaigns)?.map((a) => a.toLowerCase()), campaignSources.map((s) => s.campaigns.toLowerCase()));
    assert.deepEqual(reportScope(legacy?.campaigns ?? "")?.map((a) => a.toLowerCase()), [legacy?.campaigns.toLowerCase()]);
    assert.equal(reportScope("0x0000000000000000000000000000000000000003"), null);
  });
});
