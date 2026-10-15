"""
Trains a logistic regression loan-eligibility model on a synthetic but
realistically-distributed dataset, then exports the learned weights
folded together with the StandardScaler so the JS inference code only
needs to do a single dot product + sigmoid (no scaler needed at runtime).

FIX (v2): areaAcres was removed as a standalone feature. It overlapped
mathematically with incomePerAcre (which already = income / land size),
causing the model to learn a spurious negative weight on land size alone
(a classic multicollinearity artifact) - i.e. "more land = lower score",
which is not a logical relationship. Land size's effect is now captured
only through incomePerAcre, where it belongs.

Run: python train_eligibility_model.py
Outputs: eligibility_weights.json (consumed by the Node backend)
"""

import json
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import accuracy_score, classification_report, roc_auc_score

RNG = np.random.default_rng(42)
N = 6000

area_acres = np.clip(RNG.gamma(shape=2.0, scale=1.8, size=N), 0.2, 25)
annual_income = np.clip(RNG.normal(loc=180000, scale=90000, size=N), 20000, 900000)
requested_amount = np.clip(RNG.normal(loc=150000, scale=100000, size=N), 5000, 1000000)
existing_loans = np.clip(RNG.exponential(scale=60000, size=N), 0, 500000)
credit_history_ok = RNG.binomial(1, 0.78, size=N)

debt_to_income = (existing_loans + requested_amount) / (annual_income + 1)
income_per_acre = annual_income / (area_acres + 0.1)

score = (
    2.2 * credit_history_ok
    - 1.4 * np.clip(debt_to_income, 0, 6)
    + 0.9 * np.log1p(income_per_acre / 10000)
    - 0.6
)
prob_eligible = 1 / (1 + np.exp(-score))
noise = RNG.normal(0, 0.35, size=N)
label = ((prob_eligible + noise) > 0.5).astype(int)

X = np.column_stack([
    annual_income, requested_amount, existing_loans,
    credit_history_ok, debt_to_income, income_per_acre
])
feature_names = [
    "annualIncome", "requestedAmount", "existingLoans",
    "creditHistoryOk", "debtToIncomeRatio", "incomePerAcre"
]
y = label

X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)

scaler = StandardScaler()
X_train_scaled = scaler.fit_transform(X_train)
X_test_scaled = scaler.transform(X_test)

model = LogisticRegression(max_iter=1000)
model.fit(X_train_scaled, y_train)

y_pred = model.predict(X_test_scaled)
y_proba = model.predict_proba(X_test_scaled)[:, 1]

print("=== Evaluation on held-out test set ===")
print(f"Accuracy: {accuracy_score(y_test, y_pred):.4f}")
print(f"ROC AUC:  {roc_auc_score(y_test, y_proba):.4f}")
print(classification_report(y_test, y_pred, target_names=["not_eligible", "eligible"]))

coef = model.coef_[0]
intercept = model.intercept_[0]
mean = scaler.mean_
scale = scaler.scale_

effective_weights = coef / scale
effective_intercept = intercept - float(np.sum(coef * mean / scale))

print("\n=== Learned weights (sign check) ===")
for name, w in zip(feature_names, effective_weights):
    print(f"{name:20s} {w:+.6f}")

weights_export = {
    "featureOrder": feature_names,
    "weights": {name: float(w) for name, w in zip(feature_names, effective_weights)},
    "intercept": effective_intercept,
    "metrics": {
        "accuracy": float(accuracy_score(y_test, y_pred)),
        "rocAuc": float(roc_auc_score(y_test, y_proba)),
        "trainSize": int(len(X_train)),
        "testSize": int(len(X_test))
    },
    "note": "Logistic regression (v2) trained on synthetic data; areaAcres removed as a standalone feature to avoid a redundant/illogical negative land-size weight - land size's effect is captured only through incomePerAcre. StandardScaler folded into weights so JS inference is a single dot product + sigmoid."
}

with open("eligibility_weights.json", "w") as f:
    json.dump(weights_export, f, indent=2)

print("\nSaved eligibility_weights.json")