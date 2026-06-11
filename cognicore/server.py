"""
Yabby — CogniCore Experience Service

FastAPI sidecar that wraps the cognicore-env package to provide
failure-aware memory, reflection, and replay for OpenYabby agents.
Runs on port 3003 by default.

CogniCore stays the core technology — OpenYabby calls this service via HTTP.

Architecture:
    OpenYabby (Node.js)
          ↓ HTTP API
    CogniCore Service (this file)
          ↓ import cognicore
    Memory / ReflectionEngine / CogniCoreRuntime

Usage:
    cd cognicore
    pip install -r requirements.txt
    uvicorn server:app --port 3003
"""

import os
import time
import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional
from dataclasses import asdict

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

# ─── CogniCore imports (the core technology) ──────────────
from cognicore.middleware.memory import Memory
from cognicore.middleware.reflection import ReflectionEngine
from cognicore.runtime import CogniCoreRuntime, RuntimeConfig, ExecutionResult

app = FastAPI(title="Yabby CogniCore Experience Service")
logger = logging.getLogger("cognicore.service")

# ─── Config ───────────────────────────────────────────────

DATA_DIR = Path(os.getenv(
    "COGNICORE_DATA_DIR",
    os.path.join(os.path.dirname(__file__), "data"),
))
DATA_DIR.mkdir(parents=True, exist_ok=True)

MEMORY_MAX_SIZE = int(os.getenv("COGNICORE_MEMORY_MAX_SIZE", "50000"))
REFLECTION_MIN_SAMPLES = int(os.getenv("COGNICORE_REFLECTION_MIN_SAMPLES", "2"))
REFLECTION_FAILURE_THRESHOLD = int(os.getenv("COGNICORE_FAILURE_THRESHOLD", "2"))

# ─── CogniCore Core Instances ────────────────────────────
# One Memory + ReflectionEngine per agent, lazily created.
# The global runtime handles cross-agent operations.

_agent_runtimes: Dict[str, CogniCoreRuntime] = {}
_global_memory = Memory(
    max_size=MEMORY_MAX_SIZE,
    similarity_key="category",
)
_global_reflection = ReflectionEngine(
    memory=_global_memory,
    min_samples=REFLECTION_MIN_SAMPLES,
    failure_threshold=REFLECTION_FAILURE_THRESHOLD,
)


def _get_agent_runtime(agent_id: str) -> CogniCoreRuntime:
    """Get or create a CogniCoreRuntime for an agent."""
    if agent_id not in _agent_runtimes:
        config = RuntimeConfig(
            enable_memory=True,
            enable_reflection=True,
            memory_max_size=MEMORY_MAX_SIZE,
            memory_similarity_key="category",
            reflection_min_samples=REFLECTION_MIN_SAMPLES,
            reflection_failure_threshold=REFLECTION_FAILURE_THRESHOLD,
            persistence_path=str(DATA_DIR / f"agent_{agent_id}"),
            auto_save=True,
            verbose=False,
        )
        _agent_runtimes[agent_id] = CogniCoreRuntime(config=config)
        logger.info(f"Created CogniCore runtime for agent {agent_id}")
    return _agent_runtimes[agent_id]


# ─── Request/Response Models ─────────────────────────────

class StoreExperienceRequest(BaseModel):
    """Store a failure or success experience."""
    task_id: str
    agent_id: str
    project_id: Optional[str] = None
    workflow_id: Optional[str] = None

    # What happened
    action_taken: str
    tool_used: Optional[str] = None
    tool_args: Optional[Dict[str, Any]] = None
    category: str = "general"  # CogniCore similarity key

    # Outcome
    outcome: str = "failure"  # 'success' | 'failure' | 'partial' | 'timeout'
    failure_type: Optional[str] = None
    failure_reason: Optional[str] = None
    error_code: Optional[str] = None

    # Recovery
    recovery_strategy: Optional[str] = None
    recovery_tool: Optional[str] = None

    # Context
    channel_name: Optional[str] = None
    source_id: Optional[str] = None
    tags: List[str] = Field(default_factory=list)
    metadata: Dict[str, Any] = Field(default_factory=dict)


class QueryExperienceRequest(BaseModel):
    """Query similar past experiences."""
    query: str
    agent_id: Optional[str] = None
    project_id: Optional[str] = None
    category: Optional[str] = None
    outcome_filter: Optional[str] = None  # 'failure', 'success', None (both)
    include_fixes: bool = True
    limit: int = 5
    min_confidence: float = 0.3


class TrajectoryStepRequest(BaseModel):
    """Record a single execution step."""
    trajectory_id: str
    task_id: str
    agent_id: str
    step_index: int
    step_type: str  # 'tool_call', 'tool_result', 'llm_turn', etc.
    tool_name: Optional[str] = None
    tool_args: Optional[Dict[str, Any]] = None
    tool_result: Optional[str] = None
    duration_ms: Optional[int] = None
    is_branch_point: bool = False
    branch_label: Optional[str] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)


class ReflectionRequest(BaseModel):
    """Generate a reflection hint for an agent/category."""
    agent_id: str
    category: str
    task_context: Optional[str] = None


class ReplayRequest(BaseModel):
    """Replay/reconstruct a trajectory."""
    trajectory_id: str
    include_tool_results: bool = True
    max_steps: int = 500


# ─── Trajectory Store (in-memory + file-backed) ──────────

_trajectories: Dict[str, List[Dict[str, Any]]] = {}


def _ensure_trajectory(trajectory_id: str) -> List[Dict[str, Any]]:
    if trajectory_id not in _trajectories:
        # Try loading from disk
        traj_path = DATA_DIR / "trajectories" / f"{trajectory_id}.json"
        if traj_path.exists():
            with open(traj_path, "r") as f:
                _trajectories[trajectory_id] = json.load(f)
        else:
            _trajectories[trajectory_id] = []
    return _trajectories[trajectory_id]


def _save_trajectory(trajectory_id: str):
    traj_dir = DATA_DIR / "trajectories"
    traj_dir.mkdir(parents=True, exist_ok=True)
    traj_path = traj_dir / f"{trajectory_id}.json"
    with open(traj_path, "w") as f:
        json.dump(_trajectories.get(trajectory_id, []), f, indent=2, default=str)


# ─── Endpoints ────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "cognicore",
        "version": "0.9.3",
        "agents_loaded": len(_agent_runtimes),
        "global_memory_size": len(_global_memory.entries),
        "trajectories_tracked": len(_trajectories),
    }


@app.post("/store_experience")
async def store_experience(req: StoreExperienceRequest):
    """
    Store a failure or success experience into CogniCore Memory.

    OpenYabby calls this after every task completion (success or failure).
    CogniCore's Memory.store() handles the episodic storage.
    """
    try:
        runtime = _get_agent_runtime(req.agent_id)

        # Build CogniCore memory entry
        entry = {
            "category": req.category,
            "correct": req.outcome == "success",
            "task_id": req.task_id,
            "agent_id": req.agent_id,
            "project_id": req.project_id,
            "workflow_id": req.workflow_id,
            "action": req.action_taken,
            "tool": req.tool_used,
            "tool_args": req.tool_args or {},
            "outcome": req.outcome,
            "failure_type": req.failure_type,
            "failure_reason": req.failure_reason,
            "error_code": req.error_code,
            "recovery_strategy": req.recovery_strategy,
            "recovery_tool": req.recovery_tool,
            "channel": req.channel_name,
            "source_id": req.source_id,
            "tags": req.tags,
            "metadata": req.metadata,
            "timestamp": time.time(),
        }

        # Store into agent-specific memory via CogniCore
        runtime.memory.store(entry)

        # Also store into global memory for cross-agent learning
        _global_memory.store(entry)

        # Auto-save to disk
        runtime.save()

        logger.info(
            f"[COGNICORE] Stored experience: agent={req.agent_id} "
            f"outcome={req.outcome} category={req.category} "
            f"tool={req.tool_used}"
        )

        return {
            "stored": True,
            "agent_id": req.agent_id,
            "outcome": req.outcome,
            "category": req.category,
            "agent_memory_size": len(runtime.memory.entries),
            "global_memory_size": len(_global_memory.entries),
        }
    except Exception as e:
        logger.error(f"[COGNICORE] store_experience failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/query_experience")
async def query_experience(req: QueryExperienceRequest):
    """
    Query CogniCore Memory for similar past experiences.

    OpenYabby calls this BEFORE executing a task to inject relevant
    failure/success context into the agent's system prompt.
    """
    try:
        results = []

        # Search agent-specific memory first
        if req.agent_id and req.agent_id in _agent_runtimes:
            runtime = _agent_runtimes[req.agent_id]
            agent_entries = runtime.memory.retrieve(
                req.category or req.query,
                top_k=req.limit * 2,
            )
            results.extend(agent_entries)

        # Then search global memory for cross-agent experiences
        global_entries = _global_memory.retrieve(
            req.category or req.query,
            top_k=req.limit * 2,
        )
        results.extend(global_entries)

        # Filter by outcome
        if req.outcome_filter:
            results = [
                r for r in results
                if r.get("outcome") == req.outcome_filter
            ]

        # Filter by project
        if req.project_id:
            project_results = [
                r for r in results
                if r.get("project_id") == req.project_id
            ]
            # Fall back to all results if no project matches
            if project_results:
                results = project_results

        # Deduplicate by task_id
        seen = set()
        deduped = []
        for r in results:
            key = r.get("task_id", id(r))
            if key not in seen:
                seen.add(key)
                deduped.append(r)
        results = deduped

        # If include_fixes, find recovery strategies for failures
        fixes = []
        if req.include_fixes:
            for r in results:
                if r.get("outcome") == "failure" and r.get("category"):
                    # Look for successful resolutions of same category
                    fix_entries = _global_memory.retrieve(
                        r["category"], top_k=5
                    )
                    for fix in fix_entries:
                        if (fix.get("correct") and
                                fix.get("recovery_strategy") and
                                fix.get("task_id") != r.get("task_id")):
                            fixes.append({
                                "failure_task_id": r.get("task_id"),
                                "fix": fix,
                            })

        # Limit
        results = results[:req.limit]

        return {
            "query": req.query,
            "results": results,
            "fixes": fixes[:req.limit],
            "total_searched": len(_global_memory.entries),
        }
    except Exception as e:
        logger.error(f"[COGNICORE] query_experience failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/generate_reflection")
async def generate_reflection(req: ReflectionRequest):
    """
    Generate a CogniCore reflection hint for an agent.

    Uses CogniCore's ReflectionEngine.analyze() to find failure patterns
    and suggest overrides. Returns hints like:
      "You failed at npm test 8 times — try pinning dependencies first."
    """
    try:
        hints = []

        # Agent-specific reflection
        if req.agent_id in _agent_runtimes:
            runtime = _agent_runtimes[req.agent_id]
            analysis = runtime.reflection.analyze(req.category)
            if analysis.get("recommendation"):
                hints.append({
                    "source": "agent",
                    "agent_id": req.agent_id,
                    "category": req.category,
                    "analysis": analysis,
                    "hint": analysis.get("recommendation", ""),
                    "n_similar": analysis.get("n_similar", 0),
                    "bad_predictions": analysis.get("bad_predictions", 0),
                })

        # Global reflection (cross-agent patterns)
        global_analysis = _global_reflection.analyze(req.category)
        if global_analysis.get("recommendation"):
            hints.append({
                "source": "global",
                "category": req.category,
                "analysis": global_analysis,
                "hint": global_analysis.get("recommendation", ""),
                "n_similar": global_analysis.get("n_similar", 0),
                "bad_predictions": global_analysis.get("bad_predictions", 0),
            })

        # Get override suggestion if available
        override = None
        if req.agent_id in _agent_runtimes:
            runtime = _agent_runtimes[req.agent_id]
            proposed = req.task_context or req.category
            suggestion = runtime.reflection.suggest_override(req.category, proposed)
            if suggestion and suggestion[0]:
                override = {
                    "suggested_action": suggestion[0],
                    "confidence": suggestion[1] if len(suggestion) > 1 else 0.5,
                }

        return {
            "agent_id": req.agent_id,
            "category": req.category,
            "hints": hints,
            "override": override,
            "stats": {
                "agent_memory_size": len(
                    _agent_runtimes[req.agent_id].memory.entries
                ) if req.agent_id in _agent_runtimes else 0,
                "global_memory_size": len(_global_memory.entries),
            },
        }
    except Exception as e:
        logger.error(f"[COGNICORE] generate_reflection failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/record_trajectory_step")
async def record_trajectory_step(req: TrajectoryStepRequest):
    """
    Record a single execution step for replay/audit.

    OpenYabby calls this for every tool call, LLM turn, and
    memory retrieval during task execution.
    """
    try:
        steps = _ensure_trajectory(req.trajectory_id)

        step = {
            "trajectory_id": req.trajectory_id,
            "task_id": req.task_id,
            "agent_id": req.agent_id,
            "step_index": req.step_index,
            "step_type": req.step_type,
            "tool_name": req.tool_name,
            "tool_args": req.tool_args,
            "tool_result": (req.tool_result[:10000]
                           if req.tool_result else None),
            "duration_ms": req.duration_ms,
            "is_branch_point": req.is_branch_point,
            "branch_label": req.branch_label,
            "metadata": req.metadata,
            "recorded_at": time.time(),
        }

        steps.append(step)
        _save_trajectory(req.trajectory_id)

        return {
            "recorded": True,
            "trajectory_id": req.trajectory_id,
            "step_index": req.step_index,
            "total_steps": len(steps),
        }
    except Exception as e:
        logger.error(f"[COGNICORE] record_trajectory_step failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/replay_trajectory")
async def replay_trajectory(req: ReplayRequest):
    """
    Reconstruct an execution trajectory for debugging/comparison.

    Returns the full step-by-step trace of what an agent did,
    including tool calls, LLM turns, and branching decisions.
    """
    try:
        steps = _ensure_trajectory(req.trajectory_id)
        if not steps:
            raise HTTPException(
                status_code=404,
                detail=f"Trajectory {req.trajectory_id} not found",
            )

        # Limit steps
        steps = steps[:req.max_steps]

        # Optionally strip tool results for smaller payloads
        if not req.include_tool_results:
            steps = [
                {k: v for k, v in s.items() if k != "tool_result"}
                for s in steps
            ]

        # Compute metrics
        tool_calls = [s for s in steps if s.get("step_type") == "tool_call"]
        branch_points = [s for s in steps if s.get("is_branch_point")]
        total_duration = sum(
            s.get("duration_ms", 0) or 0 for s in steps
        )

        return {
            "trajectory_id": req.trajectory_id,
            "task_id": steps[0].get("task_id") if steps else None,
            "agent_id": steps[0].get("agent_id") if steps else None,
            "total_steps": len(steps),
            "steps": steps,
            "metrics": {
                "tool_call_count": len(tool_calls),
                "branch_point_count": len(branch_points),
                "total_duration_ms": total_duration,
                "unique_tools": list(set(
                    s.get("tool_name", "") for s in tool_calls
                    if s.get("tool_name")
                )),
            },
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[COGNICORE] replay_trajectory failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/compare_trajectories")
async def compare_trajectories(
    trajectory_a: str,
    trajectory_b: str,
):
    """
    Compare two execution trajectories to identify what changed
    between a failed run and a successful one.
    """
    try:
        steps_a = _ensure_trajectory(trajectory_a)
        steps_b = _ensure_trajectory(trajectory_b)

        if not steps_a:
            raise HTTPException(404, f"Trajectory {trajectory_a} not found")
        if not steps_b:
            raise HTTPException(404, f"Trajectory {trajectory_b} not found")

        # Find divergence point
        divergence_idx = 0
        for i, (a, b) in enumerate(zip(steps_a, steps_b)):
            if (a.get("tool_name") != b.get("tool_name") or
                    a.get("step_type") != b.get("step_type")):
                divergence_idx = i
                break
        else:
            divergence_idx = min(len(steps_a), len(steps_b))

        # Tools in A but not B and vice versa
        tools_a = set(
            s.get("tool_name", "") for s in steps_a if s.get("tool_name")
        )
        tools_b = set(
            s.get("tool_name", "") for s in steps_b if s.get("tool_name")
        )

        return {
            "trajectory_a": trajectory_a,
            "trajectory_b": trajectory_b,
            "divergence_point": divergence_idx,
            "steps_a_count": len(steps_a),
            "steps_b_count": len(steps_b),
            "tools_only_in_a": list(tools_a - tools_b),
            "tools_only_in_b": list(tools_b - tools_a),
            "tools_shared": list(tools_a & tools_b),
            "duration_a_ms": sum(
                s.get("duration_ms", 0) or 0 for s in steps_a
            ),
            "duration_b_ms": sum(
                s.get("duration_ms", 0) or 0 for s in steps_b
            ),
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[COGNICORE] compare_trajectories failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/agent/{agent_id}/stats")
async def agent_stats(agent_id: str):
    """Get CogniCore runtime stats for an agent."""
    if agent_id not in _agent_runtimes:
        return {
            "agent_id": agent_id,
            "initialized": False,
            "memory_size": 0,
        }

    runtime = _agent_runtimes[agent_id]
    stats = runtime.stats.to_dict() if hasattr(runtime, "stats") else {}
    memory_stats = runtime.memory._stats if hasattr(runtime.memory, "_stats") else {}

    return {
        "agent_id": agent_id,
        "initialized": True,
        "memory_size": len(runtime.memory.entries),
        "memory_stats": memory_stats,
        "runtime_stats": stats,
    }


@app.get("/stats")
async def global_stats():
    """Get global CogniCore stats across all agents."""
    return {
        "agents_loaded": len(_agent_runtimes),
        "global_memory_size": len(_global_memory.entries),
        "global_memory_stats": _global_memory._stats,
        "trajectories_tracked": len(_trajectories),
        "per_agent": {
            agent_id: {
                "memory_size": len(runtime.memory.entries),
            }
            for agent_id, runtime in _agent_runtimes.items()
        },
    }


@app.delete("/agent/{agent_id}/memory")
async def clear_agent_memory(agent_id: str):
    """Clear all memory for an agent."""
    if agent_id in _agent_runtimes:
        _agent_runtimes[agent_id].memory.entries.clear()
        return {"cleared": True, "agent_id": agent_id}
    return {"cleared": False, "reason": "agent not found"}


@app.post("/export")
async def export_experiences(
    agent_id: Optional[str] = None,
    format: str = "json",
):
    """Export experiences for compliance/audit (JSONL)."""
    if agent_id and agent_id in _agent_runtimes:
        entries = _agent_runtimes[agent_id].memory.entries
    else:
        entries = _global_memory.entries

    return {
        "format": format,
        "count": len(entries),
        "entries": entries,
    }
