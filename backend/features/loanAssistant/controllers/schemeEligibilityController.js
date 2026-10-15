import { loadFarmerContext } from "../services/farmerContext.js";
import { buildEligibilityProfile, evaluateSchemeEligibility } from "../services/schemeEligibilityChecks.js";
import { getAllSchemes } from "../services/schemeRetrieval.js";
import { freshnessOf } from "../services/schemeFreshness.js";

const ORDER = { eligible: 0, needs_more_info: 1, not_eligible: 2 };

/**
 * GET /api/schemes/eligibility?farmerId=...&purpose=...
 *
 * Which schemes a farmer may qualify for, from their own data alone - no loan
 * application needed. Uses ALL of their land records (limits such as PM-KISAN's 2
 * hectares are on the total holding) and the facts saved in "About you".
 *
 * `purpose` is optional free text ("cold storage for onions"); without a loan there
 * is no stated purpose, so the two purpose-based schemes (AIF, MISS) report
 * "needs more info" unless one is given.
 */
export async function getSchemeEligibility(req, res) {
  try {
    const { farmerId, purpose } = req.query;
    const { lands, facts, verifiedFields, summary } = await loadFarmerContext(farmerId);

    const profile = buildEligibilityProfile({ lands, farmer: facts, verifiedFields, loanApplication: purpose ? { purpose } : undefined });

    const schemes = getAllSchemes({ states: summary.states })
      .map((scheme) => {
        const result = evaluateSchemeEligibility(scheme, profile);
        return {
          schemeId: scheme.id,
          name: scheme.name,
          category: scheme.category,
          // when the scheme's details were last checked against an official source (null = not yet), and where
          ...freshnessOf(scheme),
          verdict: result.verdict,
          reason: result.reason,
          // "land_records" | "self_declared" | "verified": how firm the verdict is, and
          // which declared facts it rests on without a lender check.
          basis: result.basis,
          selfDeclared: result.selfDeclared,
          checks: result.checks.map((c) => ({ id: c.id, status: c.status, message: c.message })),
          // what to tell us to firm this up
          needs: [...new Set(result.checks.filter((c) => c.status === "unknown" && c.missing).map((c) => c.missing))],
        };
      })
      .sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict]);

    const counts = { eligible: 0, needs_more_info: 0, not_eligible: 0 };
    for (const s of schemes) counts[s.verdict] += 1;

    res.json({
      farmerId,
      holding: summary,
      factsSaved: Object.keys(facts),
      verifiedFields,
      counts,
      // Everything that would turn "needs more info" into a definite answer, de-duplicated.
      needsMoreInfoAbout: [...new Set(schemes.flatMap((s) => s.needs))],
      note: summary.plots === 0 ? "No land records found for this farmer yet. Add a land record to check eligibility." : undefined,
      schemes,
    });
  } catch (err) {
    console.error("Error checking scheme eligibility:", err.message);
    res.status(500).json({ error: "Failed to check scheme eligibility" });
  }
}
