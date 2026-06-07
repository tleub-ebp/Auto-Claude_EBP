"""
Cost Intelligence — Live budgets, degradation & circuit breaker.

Extends the existing CostEstimator with real-time tracking, progressive
alerts, automatic model degradation, circuit breaker for runaway agents,
and budget reservation.

Modules:
    - catalog: versioned pricing catalog for all providers
    - live_tracker: real-time token/cost accumulator
    - budget_enforcer: circuit breaker + progressive degradation
    - reservation: budget reservation system for concurrent specs
"""

from .budget_enforcer import (
    AlertLevel,
    BudgetConfig,
    BudgetEnforcer,
    BudgetStatus,
    CircuitBreakerState,
    DegradationTier,
)
from .catalog import ModelPricing, PricingCatalog
from .cost_predictor import (
    CostPrediction,
    CostPredictor,
    PredictionReport,
    SpecFootprint,
    extract_spec_footprint,
)
from .estimator import CostEstimate, PhaseEstimate, estimate_build_cost
from .live_tracker import CostEvent, LiveCostTracker, TrackerSnapshot
from .reservation import BudgetReservation, ReservationManager

__all__ = [
    # Catalog
    "PricingCatalog",
    "ModelPricing",
    # Live tracker
    "LiveCostTracker",
    "CostEvent",
    "TrackerSnapshot",
    # Budget enforcer
    "BudgetEnforcer",
    "BudgetConfig",
    "BudgetStatus",
    "AlertLevel",
    "DegradationTier",
    "CircuitBreakerState",
    # Reservation
    "ReservationManager",
    "BudgetReservation",
    # Predictor
    "CostPredictor",
    "CostPrediction",
    "PredictionReport",
    "SpecFootprint",
    "extract_spec_footprint",
    # Pre-build estimator
    "CostEstimate",
    "PhaseEstimate",
    "estimate_build_cost",
]
