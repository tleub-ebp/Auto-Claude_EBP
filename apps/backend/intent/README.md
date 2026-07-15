# Intent Recognition & Smart Routing

> Advanced intent recognition using LLM to understand the true intent behind task descriptions, with learning capabilities and proactive recommendations.

## 🎯 Overview

The Intent Recognition module goes beyond simple keyword matching to understand **what you're really trying to accomplish**. It uses Claude AI to analyze task descriptions semantically, learns from your feedback, and provides intelligent recommendations.

## ✨ Features

### 1. **LLM-Based Intent Recognition**
- Semantic understanding using Claude AI
- Multi-dimensional intent classification
- Confidence scoring with alternatives
- Context-aware analysis

### 2. **Learning from Feedback**
- Tracks detection accuracy
- Learns project-specific patterns
- Identifies common misclassifications
- Improves over time

### 3. **Proactive Recommendations**
- Similar tasks from history
- Best practices for intent type
- Required tests and tools
- Estimated complexity and duration
- Risk warnings

### 4. **Smart Routing**
- Automatic workflow type selection
- Intent-aware phase generation
- Specialized templates per intent
- Risk-based validation

## 🚀 Quick Start

### Analyze Intent from Command Line

```bash
# Analyze a task description
cd apps/backend
python -m intent analyze "Add OAuth2 authentication with Google and GitHub"

# Analyze from spec directory
python -m intent analyze --spec-dir .workpilot/specs/001-feature/

# Get recommendations
python -m intent recommend "Fix slow dashboard loading"
```

### Use in Python Code

```python
from intent import IntentRecognizer, IntentRecommender

# Analyze intent
recognizer = IntentRecognizer()
analysis = recognizer.analyze_intent(
    "The login page returns 500 error when password has special characters"
)

print(f"Intent: {analysis.primary_intent.category.value}")
print(f"Confidence: {analysis.primary_intent.confidence_score:.1%}")
print(f"Workflow: {analysis.primary_intent.workflow_type.value}")

# Get recommendations
recommender = IntentRecommender()
recs = recommender.generate_recommendations(analysis)

print(f"\nEstimated: {recs.estimated_complexity}")
print(f"Duration: {recs.estimated_duration_hours[0]}-{recs.estimated_duration_hours[1]}h")

for rec in recs.recommendations:
    print(f"  • {rec.title}")
```

### Automatic Integration

Intent recognition is **automatically integrated** into the planner:

```python
from pathlib import Path
from planner_lib.context import ContextLoader

# Load context with LLM intent recognition (enabled by default)
loader = ContextLoader(Path("./specs/001-feature/"))
context = loader.load_context()

# Intent is detected and cached in intent_analysis.json
print(f"Detected workflow: {context.workflow_type.value}")
```

## 📊 Intent Categories

### Feature Development
- `new_feature` - Building something completely new
- `enhancement` - Improving existing functionality
- `api_design` - Designing or modifying APIs
- `ui_ux` - User interface improvements

### Fixes & Maintenance
- `bug_fix` - Fixing broken functionality
- `hotfix` - Urgent critical fix
- `security_fix` - Security vulnerabilities

### Quality & Performance
- `refactoring` - Code restructuring
- `performance` - Speed/resource optimization
- `code_quality` - Maintainability improvements

### Infrastructure & Operations
- `infrastructure` - Docker, CI/CD, deployment
- `deployment` - Release management
- `monitoring` - Logging, metrics, observability

### Research & Analysis
- `investigation` - Debugging unknown issues
- `spike` - Time-boxed research
- `research` - Requirements or feasibility study

### Data & Migration
- `data_migration` - Moving/transforming data
- `schema_change` - Database schema modifications

### Documentation & Testing
- `documentation` - Writing or updating docs
- `testing` - Adding or improving tests

## 🎓 Learning & Feedback

### Record Feedback

```bash
# Record that intent was correctly detected
python -m intent feedback \
  --task-id 001 \
  --detected bug_fix \
  --actual bug_fix \
  --confidence 0.95

# Record a correction
python -m intent feedback \
  --task-id 002 \
  --detected enhancement \
  --actual new_feature \
  --notes "This was actually a new feature, not just an enhancement"
```

### View Metrics

```bash
# Overall accuracy
python -m intent metrics

# Project-specific metrics
python -m intent metrics --project-id my-project
```

**Example Output:**
```
Intent Detection Accuracy

Total Feedbacks: 50
Overall Accuracy: 84.0%
Correct Predictions: 42

By Category:
┌──────────────┬──────────┬─────────┬───────┐
│ Category     │ Accuracy │ Correct │ Total │
├──────────────┼──────────┼─────────┼───────┤
│ bug_fix      │   95.0%  │    19   │   20  │
│ new_feature  │   80.0%  │    12   │   15  │
│ enhancement  │   73.3%  │    11   │   15  │
└──────────────┴──────────┴─────────┴───────┘
```

## 🔧 Configuration

### Enable/Disable LLM Intent Recognition

```python
# Enable (default)
loader = ContextLoader(spec_dir, use_llm_intent=True)

# Disable (fallback to keywords only)
loader = ContextLoader(spec_dir, use_llm_intent=False)
```

### Custom Model

```python
from intent import IntentRecognizer

# Use specific Claude model
recognizer = IntentRecognizer(model="claude-3-opus-20240229")
```

### Storage Location

Learning data is stored in `~/.workpilot/intent/`:
- `feedback.jsonl` - User feedback records
- `project_patterns.json` - Learned project patterns

## 📈 Priority Levels

Intent detection uses **5 priority levels** (highest to lowest):

1. **requirements.json** - User's explicit intent
2. **complexity_assessment.json** - AI's assessment
3. **LLM Intent Recognition** - Semantic understanding ✨ NEW
4. **spec.md explicit declaration** - Spec writer's declaration
5. **Keyword-based detection** - Last resort fallback

## 🎯 Example Outputs

### Bug Fix Intent

```
🎯 Primary Intent
┌──────────────────────────────────────────────┐
│ Category: bug_fix                            │
│ Workflow: investigation                      │
│ Confidence: 95% (very_high)                  │
│                                              │
│ Reasoning:                                   │
│ Clear bug report with specific error and     │
│ reproduction steps. The 500 error on login   │
│ page indicates a server-side bug.            │
│                                              │
│ Keywords: error, returns 500, bug            │
└──────────────────────────────────────────────┘

Recommendations:
  ⚠️  Regression Test Required (100%)
     Add a test that reproduces the bug to prevent regression.

  💡 Debug Logging (85%)
     Add detailed logging around the error to capture context.
```

### Performance Issue

```
🎯 Primary Intent
┌──────────────────────────────────────────────┐
│ Category: performance                        │
│ Workflow: investigation                      │
│ Confidence: 70% (medium)                     │
│                                              │
│ Reasoning:                                   │
│ Performance complaint but root cause unknown.│
│ Needs investigation to determine if this is  │
│ optimization or a bug causing slowness.      │
│                                              │
│ Keywords: slow, users complain               │
└──────────────────────────────────────────────┘

⚠️  Clarification Needed
  1. Is this a recent regression or long-standing issue?
  2. Do you have performance metrics (load time)?
  3. Does this affect all users or specific scenarios?

Alternative Interpretations:
  1. bug_fix (30%) - Could be a bug causing slowness

Recommendations:
  💡 Benchmark Before & After (90%)
     Establish baseline metrics before optimization.

  🔧 Performance Tests Required (85%)
     Add performance tests to prevent regression.
```

## 🏗️ Architecture

```
intent/
├── __init__.py          # Module exports
├── __main__.py          # CLI entry point
├── models.py            # Data models (Intent, IntentAnalysis)
├── prompt.py            # LLM prompt for intent recognition
├── recognizer.py        # Main intent recognition engine
├── learner.py           # Learning from feedback
├── recommender.py       # Recommendation generation
└── cli.py               # Command-line interface
```

## 🧪 Testing

```bash
# Run intent recognition tests
cd ../../
pytest tests/test_intent_recognition.py -v

# Test with real LLM (requires API key)
cd apps/backend
python -m intent analyze "Add Redis caching for user sessions"
```

## 🔮 Future Enhancements

- [ ] UI integration (VS Code / JetBrains)
- [ ] Similar task search from project history
- [ ] Team-level pattern learning
- [ ] Multi-language support
- [ ] Real-time intent detection as you type

## 📚 Related Modules

- **planner_lib** - Uses intent for workflow routing
- **risk_classifier** - Complements with risk analysis
- **implementation_plan** - Structures work based on intent
- **review** - Validates against intended purpose

## 🤝 Contributing

When adding new intent categories:

1. Add to `IntentCategory` enum in `models.py`
2. Update the prompt in `prompt.py` with examples
3. Add recommendations logic in `recommender.py`
4. Add test cases in `test_intent_recognition.py`

## 📄 License

Same license as WorkPilot AI project.

---

**Made with ❤️ for better task understanding**

