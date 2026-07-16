/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { getStrategicHint, TargetCandidate } from '../services/geminiService';
import { Point, Bubble, Particle, BubbleColor, DebugInfo } from '../types';
import { 
  Loader2, Trophy, BrainCircuit, Play, MousePointerClick, Eye, Terminal, Clock, 
  AlertTriangle, Target, Lightbulb, Monitor, User, LogOut, Sparkles, Video, MousePointer,
  Pause, RotateCcw, Home
} from 'lucide-react';
import { 
  auth, 
  signInWithGoogle, 
  logoutUser, 
  getUserProfile, 
  createUserProfile, 
  updateHighScore, 
  submitScoreToLeaderboard, 
  subscribeToLeaderboard,
  LeaderboardEntryData
} from '../services/firebase';
import { onAuthStateChanged } from 'firebase/auth';

// Single global instance to prevent Emscripten module collision during React StrictMode/double-renders
let globalHands: any = null;

const PINCH_THRESHOLD = 0.05;
const GRAVITY = 0.0; 
const FRICTION = 0.998; 

const BUBBLE_RADIUS = 22;
const ROW_HEIGHT = BUBBLE_RADIUS * Math.sqrt(3);
const GRID_COLS = 12;
const GRID_ROWS = 8;
const SLINGSHOT_BOTTOM_OFFSET = 220;

const MAX_DRAG_DIST = 180;
const MIN_FORCE_MULT = 0.15;
const MAX_FORCE_MULT = 0.45;

// Material Design Colors & Scoring Strategy
const COLOR_CONFIG: Record<BubbleColor, { hex: string, points: number, label: string }> = {
  red:    { hex: '#ef5350', points: 100, label: 'Red' },     // Material Red 400
  blue:   { hex: '#42a5f5', points: 150, label: 'Blue' },    // Material Blue 400
  green:  { hex: '#66bb6a', points: 200, label: 'Green' },   // Material Green 400
  yellow: { hex: '#ffee58', points: 250, label: 'Yellow' },  // Material Yellow 400
  purple: { hex: '#ab47bc', points: 300, label: 'Purple' },  // Material Purple 400
  orange: { hex: '#ffa726', points: 500, label: 'Orange' }   // Material Orange 400
};

const COLOR_KEYS: BubbleColor[] = ['red', 'blue', 'green', 'yellow', 'purple', 'orange'];

// Color Helper for Gradients
const adjustColor = (color: string, amount: number) => {
    const hex = color.replace('#', '');
    const r = Math.max(0, Math.min(255, parseInt(hex.substring(0, 2), 16) + amount));
    const g = Math.max(0, Math.min(255, parseInt(hex.substring(2, 4), 16) + amount));
    const b = Math.max(0, Math.min(255, parseInt(hex.substring(4, 6), 16) + amount));
    
    const componentToHex = (c: number) => {
        const hex = c.toString(16);
        return hex.length === 1 ? "0" + hex : hex;
    };
    
    return "#" + componentToHex(r) + componentToHex(g) + componentToHex(b);
};

const getBubblePos = (row: number, col: number, width: number, yOffset: number = 0) => {
    const xOffset = (width - (GRID_COLS * BUBBLE_RADIUS * 2)) / 2 + BUBBLE_RADIUS;
    const isOdd = row % 2 !== 0;
    const x = xOffset + col * (BUBBLE_RADIUS * 2) + (isOdd ? BUBBLE_RADIUS : 0);
    const y = BUBBLE_RADIUS + row * ROW_HEIGHT + yOffset;
    return { x, y };
};

const getTrajectory = (
  startPos: Point,
  startVel: Point,
  bubblesList: Bubble[],
  canvasWidth: number
) => {
  const pathPoints: Point[] = [{ x: startPos.x, y: startPos.y }];
  let simPos = { x: startPos.x, y: startPos.y };
  let simVel = { x: startVel.x, y: startVel.y };
  
  let collisionOccurred = false;
  const maxSteps = 400;
  let stepCount = 0;
  
  while (!collisionOccurred && stepCount < maxSteps) {
    stepCount++;
    const currentSpeed = Math.sqrt(simVel.x ** 2 + simVel.y ** 2);
    if (currentSpeed < 0.1) break;
    
    const steps = Math.ceil(currentSpeed / (BUBBLE_RADIUS * 0.8));
    let subCollision = false;
    
    for (let i = 0; i < steps; i++) {
      simPos.x += simVel.x / steps;
      simPos.y += simVel.y / steps;
      
      // Wall bounces
      if (simPos.x < BUBBLE_RADIUS || simPos.x > canvasWidth - BUBBLE_RADIUS) {
        simVel.x *= -1;
        simPos.x = Math.max(BUBBLE_RADIUS, Math.min(canvasWidth - BUBBLE_RADIUS, simPos.x));
        pathPoints.push({ x: simPos.x, y: simPos.y });
      }
      
      // Ceiling hit
      if (simPos.y < BUBBLE_RADIUS) {
        collisionOccurred = true;
        subCollision = true;
        break;
      }
      
      // Bubble hit
      for (const b of bubblesList) {
        if (!b.active) continue;
        const dist = Math.sqrt(
          Math.pow(simPos.x - b.x, 2) + 
          Math.pow(simPos.y - b.y, 2)
        );
        if (dist < BUBBLE_RADIUS * 1.8) { 
          collisionOccurred = true;
          subCollision = true;
          break;
        }
      }
      if (subCollision) break;
    }
    
    simVel.y += GRAVITY;
    simVel.x *= FRICTION;
    simVel.y *= FRICTION;
    
    if (stepCount % 2 === 0 || subCollision) {
      pathPoints.push({ x: simPos.x, y: simPos.y });
    }
    
    if (subCollision) break;
  }
  
  return { pathPoints, lastPos: simPos, collisionOccurred };
};

const GeminiSlingshot: React.FC = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameContainerRef = useRef<HTMLDivElement>(null);
  
  // Game State Refs
  const ballPos = useRef<Point>({ x: 0, y: 0 });
  const ballVel = useRef<Point>({ x: 0, y: 0 });
  const anchorPos = useRef<Point>({ x: 0, y: 0 });
  const isPinching = useRef<boolean>(false);
  const isFlying = useRef<boolean>(false);
  const flightStartTime = useRef<number>(0);
  const bubbles = useRef<Bubble[]>([]);
  const particles = useRef<Particle[]>([]);
  const scoreRef = useRef<number>(0);
  
  const aimTargetRef = useRef<Point | null>(null);
  const isAiThinkingRef = useRef<boolean>(false);
  const latestResultsRef = useRef<any>(null);
  
  // AI Request Trigger
  const captureRequestRef = useRef<boolean>(false);

  // Current active color (Ref for loop, State for UI)
  const selectedColorRef = useRef<BubbleColor>('red');
  
  // React State
  const [loading, setLoading] = useState(true);
  const [aiHint, setAiHint] = useState<string | null>("ยินดีต้อนรับสู่โหมด High-Speed! คุณสามารถกดปุ่มวิเคราะห์ด้านขวาเมื่อต้องการคำแนะนำจาก AI");
  const [aiRationale, setAiRationale] = useState<string | null>(null);
  const [aimTarget, setAimTarget] = useState<Point | null>(null);
  const [score, setScore] = useState(0);
  const [isAiThinking, setIsAiThinking] = useState(false);
  const [selectedColor, setSelectedColor] = useState<BubbleColor>('red');
  const [availableColors, setAvailableColors] = useState<BubbleColor[]>([]);
  const [aiRecommendedColor, setAiRecommendedColor] = useState<BubbleColor | null>(null);
  const [debugInfo, setDebugInfo] = useState<DebugInfo | null>(null);

  // Progression & Difficulty States and Refs
  const levelRef = useRef<number>(1);
  const totalPopsRef = useRef<number>(0);
  const yOffsetRef = useRef<number>(0);
  const isGameOverRef = useRef<boolean>(false);

  const [gameStarted, setGameStarted] = useState(false);
  const [controlMode, setControlMode] = useState<'mouse' | 'webcam'>('mouse');
  const [level, setLevel] = useState(1);
  const [totalPops, setTotalPops] = useState(0);
  const [isGameOver, setIsGameOver] = useState(false);
  const [levelUpFlash, setLevelUpFlash] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const isPausedRef = useRef<boolean>(false);

  // Pointer tracking for Mouse Mode
  const isPointerDownRef = useRef(false);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (controlMode !== 'mouse' || isGameOverRef.current || isPausedRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    isPointerDownRef.current = true;
    try {
      (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    } catch (err) {}

    const isLocked = isAiThinkingRef.current;
    if (!isLocked && !isFlying.current) {
      const distToBall = Math.sqrt(Math.pow(x - ballPos.current.x, 2) + Math.pow(y - ballPos.current.y, 2));
      // Generous grab radius of 120px, or anywhere near the bottom launcher band
      if (distToBall < 120 || y > canvas.height - 250) {
        isPinching.current = true;
        ballPos.current = { x, y };
      }
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (controlMode !== 'mouse' || isGameOverRef.current || isPausedRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (isPinching.current) {
      ballPos.current = { x, y };
      const dragDx = ballPos.current.x - anchorPos.current.x;
      const dragDy = ballPos.current.y - anchorPos.current.y;
      const dragDist = Math.sqrt(dragDx * dragDx + dragDy * dragDy);

      if (dragDist > MAX_DRAG_DIST) {
        const angle = Math.atan2(dragDy, dragDx);
        ballPos.current.x = anchorPos.current.x + Math.cos(angle) * MAX_DRAG_DIST;
        ballPos.current.y = anchorPos.current.y + Math.sin(angle) * MAX_DRAG_DIST;
      }
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (controlMode !== 'mouse' || isGameOverRef.current || isPausedRef.current) return;
    isPointerDownRef.current = false;
    try {
      (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId);
    } catch (err) {}

    if (isPinching.current) {
      isPinching.current = false;
      const isLocked = isAiThinkingRef.current;

      if (isLocked) {
        ballPos.current = { ...anchorPos.current };
      } else {
        const dx = anchorPos.current.x - ballPos.current.x;
        const dy = anchorPos.current.y - ballPos.current.y;
        const stretchDist = Math.sqrt(dx * dx + dy * dy);

        if (stretchDist > 30) {
          isFlying.current = true;
          flightStartTime.current = performance.now();
          const powerRatio = Math.min(stretchDist / MAX_DRAG_DIST, 1.0);
          const velocityMultiplier = MIN_FORCE_MULT + (MAX_FORCE_MULT - MIN_FORCE_MULT) * (powerRatio * powerRatio);

          ballVel.current = {
            x: dx * velocityMultiplier,
            y: dy * velocityMultiplier
          };
        } else {
          ballPos.current = { ...anchorPos.current };
        }
      }
    }
  };

  // Firebase Auth and Leaderboard State
  const [currentUser, setCurrentUser] = useState<any>(null);
  const [firebaseProfile, setFirebaseProfile] = useState<any>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntryData[]>([]);
  const [activeTab, setActiveTab] = useState<'leaderboard' | 'debug'>('leaderboard');
  const [isSyncingScore, setIsSyncingScore] = useState(false);

  // Subscribe to Authentication State
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setCurrentUser(user);
      if (user) {
        try {
          let profile = await getUserProfile(user.uid);
          if (!profile) {
            await createUserProfile(user.uid, user.displayName || 'Anonymous Player');
            profile = await getUserProfile(user.uid);
          }
          setFirebaseProfile(profile);
        } catch (e) {
          console.error("Error setting up user profile in Firestore:", e);
        }
      } else {
        setFirebaseProfile(null);
      }
    });

    return () => unsubscribe();
  }, []);

  // Subscribe to Leaderboard Real-Time updates
  useEffect(() => {
    const unsubscribe = subscribeToLeaderboard(
      (entries) => {
        setLeaderboard(entries);
      },
      (error) => {
        console.error("Leaderboard subscription error:", error);
      }
    );

    return () => unsubscribe();
  }, []);

  // Sync high scores to Firestore automatically in real-time
  useEffect(() => {
    if (!currentUser || !firebaseProfile) return;
    
    if (score > firebaseProfile.highScore) {
      const updateScores = async () => {
        setIsSyncingScore(true);
        try {
          await updateHighScore(currentUser.uid, firebaseProfile.highScore, score);
          // Also submit to global leaderboard so it updates instantly
          await submitScoreToLeaderboard(
            currentUser.uid, 
            currentUser.displayName || 'Anonymous Player', 
            score
          );
          // Update local profile state to prevent duplicate triggering
          setFirebaseProfile((prev: any) => prev ? { ...prev, highScore: score } : null);
        } catch (e) {
          console.error("Failed to sync score with Firebase:", e);
        } finally {
          setIsSyncingScore(false);
        }
      };

      const debounceTimeout = setTimeout(updateScores, 1500); // Debounce to avoid constant writes during a combo
      return () => clearTimeout(debounceTimeout);
    }
  }, [score, currentUser, firebaseProfile]);

  const handleLogin = async () => {
    try {
      await signInWithGoogle();
    } catch (e) {
      console.error("Google Sign-In failed:", e);
    }
  };

  const handleLogout = async () => {
    try {
      await logoutUser();
    } catch (e) {
      console.error("Sign Out failed:", e);
    }
  };

  // Sync state to ref
  useEffect(() => {
    selectedColorRef.current = selectedColor;
  }, [selectedColor]);

  useEffect(() => {
    aimTargetRef.current = aimTarget;
  }, [aimTarget]);

  useEffect(() => {
    isAiThinkingRef.current = isAiThinking;
  }, [isAiThinking]);

  useEffect(() => {
    isPausedRef.current = isPaused;
  }, [isPaused]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (gameStarted && !isGameOverRef.current) {
          setIsPaused(prev => !prev);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [gameStarted]);
  
  const updateAvailableColors = () => {
    const activeColors = new Set<BubbleColor>();
    bubbles.current.forEach(b => {
        if (b.active) activeColors.add(b.color);
    });
    setAvailableColors(Array.from(activeColors));
    
    // If current selected color is gone, switch to first available
    if (!activeColors.has(selectedColorRef.current) && activeColors.size > 0) {
        const next = Array.from(activeColors)[0];
        setSelectedColor(next);
    }
  };

  const initGrid = useCallback((width: number) => {
    const newBubbles: Bubble[] = [];
    for (let r = 0; r < 5; r++) { 
      for (let c = 0; c < (r % 2 !== 0 ? GRID_COLS - 1 : GRID_COLS); c++) {
        if (Math.random() > 0.1) {
            const { x, y } = getBubblePos(r, c, width);
            newBubbles.push({
              id: `${r}-${c}`,
              row: r,
              col: c,
              x,
              y,
              color: COLOR_KEYS[Math.floor(Math.random() * COLOR_KEYS.length)],
              active: true
            });
        }
      }
    }
    bubbles.current = newBubbles;
    
    // Pick an initial projectile color from the grid colors
    const activeColors = new Set<BubbleColor>();
    newBubbles.forEach(b => {
        if (b.active) activeColors.add(b.color);
    });
    const colorsList = Array.from(activeColors);
    if (colorsList.length > 0) {
        setSelectedColor(colorsList[Math.floor(Math.random() * colorsList.length)]);
    } else {
        setSelectedColor(COLOR_KEYS[Math.floor(Math.random() * COLOR_KEYS.length)]);
    }

    updateAvailableColors();
  }, []);

  const resetGame = () => {
    scoreRef.current = 0;
    setScore(0);
    totalPopsRef.current = 0;
    setTotalPops(0);
    levelRef.current = 1;
    setLevel(1);
    yOffsetRef.current = 0;
    isGameOverRef.current = false;
    setIsGameOver(false);
    
    if (canvasRef.current) {
      initGrid(canvasRef.current.width);
    }
    
    ballPos.current = { ...anchorPos.current };
    ballVel.current = { x: 0, y: 0 };
    isFlying.current = false;
    isPinching.current = false;
  };

  const createExplosion = (x: number, y: number, color: string) => {
    for (let i = 0; i < 15; i++) {
      particles.current.push({
        x,
        y,
        vx: (Math.random() - 0.5) * 12,
        vy: (Math.random() - 0.5) * 12,
        life: 1.0,
        color
      });
    }
  };

  const isPathClear = (target: Bubble) => {
    if (!anchorPos.current) return false;
    
    const startX = anchorPos.current.x;
    const startY = anchorPos.current.y;
    const endX = target.x;
    const endY = target.y;

    const dx = endX - startX;
    const dy = endY - startY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const steps = Math.ceil(distance / (BUBBLE_RADIUS / 2)); 

    for (let i = 1; i < steps - 2; i++) { 
        const t = i / steps;
        const cx = startX + dx * t;
        const cy = startY + dy * t;

        for (const b of bubbles.current) {
            if (!b.active || b.id === target.id) continue;
            const distSq = Math.pow(cx - b.x, 2) + Math.pow(cy - b.y, 2);
            if (distSq < Math.pow(BUBBLE_RADIUS * 1.8, 2)) {
                return false; 
            }
        }
    }
    return true;
  };

  const getAllReachableClusters = (): TargetCandidate[] => {
    const activeBubbles = bubbles.current.filter(b => b.active);
    const uniqueColors = Array.from(new Set(activeBubbles.map(b => b.color))) as BubbleColor[];
    const allClusters: TargetCandidate[] = [];

    // Analyze opportunities for ALL colors
    for (const color of uniqueColors) {
        const visited = new Set<string>();
        
        for (const b of activeBubbles) {
            if (b.color !== color || visited.has(b.id)) continue;

            const clusterMembers: Bubble[] = [];
            const queue = [b];
            visited.add(b.id);

            while (queue.length > 0) {
                const curr = queue.shift()!;
                clusterMembers.push(curr);
                
                const neighbors = activeBubbles.filter(n => 
                    !visited.has(n.id) && n.color === color && isNeighbor(curr, n)
                );
                neighbors.forEach(n => {
                    visited.add(n.id);
                    queue.push(n);
                });
            }

            // Check if this cluster is hittable
            clusterMembers.sort((a,b) => b.y - a.y); 
            const hittableMember = clusterMembers.find(m => isPathClear(m));

            if (hittableMember) {
                const xPct = hittableMember.x / (gameContainerRef.current?.clientWidth || window.innerWidth);
                let desc = "Center";
                if (xPct < 0.33) desc = "Left";
                else if (xPct > 0.66) desc = "Right";

                allClusters.push({
                    id: hittableMember.id,
                    color: color,
                    size: clusterMembers.length,
                    row: hittableMember.row,
                    col: hittableMember.col,
                    pointsPerBubble: COLOR_CONFIG[color].points,
                    description: `${desc}`
                });
            }
        }
    }
    return allClusters;
  };

  const checkMatches = (startBubble: Bubble) => {
    const toCheck = [startBubble];
    const visited = new Set<string>();
    const matches: Bubble[] = [];
    const targetColor = startBubble.color;

    while (toCheck.length > 0) {
      const current = toCheck.pop()!;
      if (visited.has(current.id)) continue;
      visited.add(current.id);

      if (current.color === targetColor) {
        matches.push(current);
        const neighbors = bubbles.current.filter(b => b.active && !visited.has(b.id) && isNeighbor(current, b));
        toCheck.push(...neighbors);
      }
    }

    if (matches.length >= 3) {
      let points = 0;
      const basePoints = COLOR_CONFIG[targetColor].points;
      
      matches.forEach(b => {
        b.active = false;
        createExplosion(b.x, b.y, COLOR_CONFIG[b.color].hex);
        points += basePoints;
      });
      // Combo Multiplier
      const multiplier = matches.length > 3 ? 1.5 : 1.0;
      scoreRef.current += Math.floor(points * multiplier);
      setScore(scoreRef.current);

      // Progression system: count pops and update level
      const poppedCount = matches.length;
      totalPopsRef.current += poppedCount;
      setTotalPops(totalPopsRef.current);

      const nextLevel = Math.floor(totalPopsRef.current / 12) + 1;
      if (nextLevel > levelRef.current) {
        levelRef.current = nextLevel;
        setLevel(nextLevel);
        setLevelUpFlash(true);
        setTimeout(() => setLevelUpFlash(false), 2000);
      }

      return true;
    }
    return false;
  };

  const isNeighbor = (a: Bubble, b: Bubble) => {
    const dr = b.row - a.row;
    const dc = b.col - a.col;
    if (Math.abs(dr) > 1) return false;
    if (dr === 0) return Math.abs(dc) === 1;
    if (a.row % 2 !== 0) {
        return dc === 0 || dc === 1;
    } else {
        return dc === -1 || dc === 0;
    }
  };

  const performAiAnalysis = async (screenshot: string) => {
    // Lock interaction immediately via ref (fast) and state (render)
    isAiThinkingRef.current = true;
    setIsAiThinking(true);
    setAiHint("กำลังวิเคราะห์แผนการยิงที่ดีที่สุด...");
    setAiRationale(null);
    setAiRecommendedColor(null);
    setAimTarget(null);

    // Client-Side Pre-Calc for ALL colors for instant hint line
    const allClusters = getAllReachableClusters();
    const maxRow = bubbles.current.reduce((max, b) => b.active ? Math.max(max, b.row) : max, 0);
    const canvasWidth = canvasRef.current?.width || 1000;

    // Instantly show the best local target so the user has immediate laser guide line!
    const bestLocal = [...allClusters].sort((a, b) => {
      const scoreA = a.size * a.pointsPerBubble;
      const scoreB = b.size * b.pointsPerBubble;
      return (scoreB - scoreA) || (a.row - b.row);
    })[0];

    if (bestLocal) {
      const pos = getBubblePos(bestLocal.row, bestLocal.col, canvasWidth, yOffsetRef.current);
      setAimTarget(pos);
      setAiHint(`เป้าหมายแนะนำ (ด่วน): ยิงสี ${COLOR_CONFIG[bestLocal.color as BubbleColor].label} ที่แถว ${bestLocal.row}`);
    }

    getStrategicHint(
        screenshot,
        allClusters,
        maxRow
    ).then(aiResponse => {
        const { hint, debug } = aiResponse;
        setDebugInfo(debug);
        setAiHint(hint.message);
        setAiRationale(hint.rationale || null);
        
        if (typeof hint.targetRow === 'number' && typeof hint.targetCol === 'number') {
            if (hint.recommendedColor) {
                setAiRecommendedColor(hint.recommendedColor);
                setSelectedColor(hint.recommendedColor); // Auto-equip recommendation
            }
            const pos = getBubblePos(hint.targetRow, hint.targetCol, canvasWidth, yOffsetRef.current);
            setAimTarget(pos);
        }
        
        // Unlock
        isAiThinkingRef.current = false;
        setIsAiThinking(false);
    });
  };

  // --- Rendering Helper ---
  const drawBubble = (ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, colorKey: BubbleColor) => {
    const config = COLOR_CONFIG[colorKey];
    const baseColor = config.hex;
    
    // Main Sphere Gradient (gives 3D depth)
    // Shifted focus to top-left for light source
    const grad = ctx.createRadialGradient(x - radius * 0.3, y - radius * 0.3, radius * 0.1, x, y, radius);
    grad.addColorStop(0, '#ffffff');             // Specular highlight center (brightest)
    grad.addColorStop(0.2, baseColor);           // Main color body
    grad.addColorStop(1, adjustColor(baseColor, -60)); // Shadowed edge (darkest)

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    // Subtle Outline for definition
    ctx.strokeStyle = adjustColor(baseColor, -80);
    ctx.lineWidth = 1;
    ctx.stroke();
    
    // Secondary "Glossy" Highlight (Hard reflection)
    ctx.beginPath();
    ctx.ellipse(x - radius * 0.3, y - radius * 0.35, radius * 0.25, radius * 0.15, Math.PI / 4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.fill();
  };

  // --- Main Game Loop ---

  useEffect(() => {
    if (!gameStarted) return;
    if (!videoRef.current || !canvasRef.current || !gameContainerRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const container = gameContainerRef.current;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    
    // Set initial size based on container
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;

    anchorPos.current = { x: canvas.width / 2, y: canvas.height - SLINGSHOT_BOTTOM_OFFSET };
    ballPos.current = { ...anchorPos.current };
    
    initGrid(canvas.width);

    let camera: any = null;
    let hands: any = null;

    const onResults = (results: any) => {
      setLoading(false);
      const isPausedState = isPausedRef.current;
      
      // Responsive Resize
      if (canvas.width !== container.clientWidth || canvas.height !== container.clientHeight) {
        canvas.width = container.clientWidth;
        canvas.height = container.clientHeight;
        anchorPos.current = { x: canvas.width / 2, y: canvas.height - SLINGSHOT_BOTTOM_OFFSET };
        if (!isFlying.current && !isPinching.current) {
          ballPos.current = { ...anchorPos.current };
        }
      }

      ctx.save();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      // Draw Video Feed if Webcam Mode, otherwise draw Starry Space
      if (controlMode === 'webcam' && results && results.image) {
        ctx.drawImage(results.image, 0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'rgba(18, 18, 18, 0.85)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      } else {
        // Starry digital grid background for Mouse Mode
        ctx.fillStyle = '#121212';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        // Grid pattern
        ctx.strokeStyle = 'rgba(66, 165, 245, 0.04)';
        ctx.lineWidth = 1;
        const gridSpacing = 40;
        for (let x = 0; x < canvas.width; x += gridSpacing) {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, canvas.height);
          ctx.stroke();
        }
        for (let y = 0; y < canvas.height; y += gridSpacing) {
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(canvas.width, y);
          ctx.stroke();
        }

        // Ambient glowing orbs
        const timeVal = performance.now();
        const glowX1 = canvas.width * 0.2 + Math.sin(timeVal * 0.0003) * 60;
        const glowY1 = canvas.height * 0.35 + Math.cos(timeVal * 0.0003) * 60;
        const grad1 = ctx.createRadialGradient(glowX1, glowY1, 10, glowX1, glowY1, 220);
        grad1.addColorStop(0, 'rgba(171, 71, 188, 0.06)');
        grad1.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = grad1;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const glowX2 = canvas.width * 0.75 + Math.cos(timeVal * 0.0004) * 60;
        const glowY2 = canvas.height * 0.65 + Math.sin(timeVal * 0.0004) * 60;
        const grad2 = ctx.createRadialGradient(glowX2, glowY2, 10, glowX2, glowY2, 220);
        grad2.addColorStop(0, 'rgba(66, 165, 245, 0.06)');
        grad2.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = grad2;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }

      // --- DRIFT & SWAY PROGRESSION LOGIC ---
      const time = performance.now();
      const currentLevel = levelRef.current;
      const isGameOverState = isGameOverRef.current;

      if (!isGameOverState && !isPausedState) {
        // Increase yOffset over time based on level
        // At Level 1: 0.02 pixels per frame
        // At Level 2: 0.035 pixels per frame, etc.
        yOffsetRef.current += 0.02 + currentLevel * 0.015;

        // Auto-shift row indices and spawn new rows when yOffset exceeds ROW_HEIGHT
        if (yOffsetRef.current >= ROW_HEIGHT) {
          yOffsetRef.current -= ROW_HEIGHT;
          
          // Shift rows of existing active bubbles
          bubbles.current.forEach(b => {
            if (b.active) {
              b.row += 1;
            }
          });
          
          // Filter out inactive/popped bubbles to keep list clean & high-performance
          bubbles.current = bubbles.current.filter(b => b.active);
          
          // Spawn a new dense row at the top (row 0)
          // The density (chance of spawning) increases as the level increases!
          const spawnProb = Math.min(0.4 + currentLevel * 0.08, 0.90);
          const newBubbles: Bubble[] = [];
          const colsInRow = GRID_COLS; // row 0 is even, so GRID_COLS columns
          
          for (let c = 0; c < colsInRow; c++) {
            if (Math.random() < spawnProb) {
              const { x, y } = getBubblePos(0, c, canvas.width, yOffsetRef.current);
              newBubbles.push({
                id: `spawned-0-${c}-${Date.now()}-${Math.random()}`,
                row: 0,
                col: c,
                x,
                y,
                color: COLOR_KEYS[Math.floor(Math.random() * COLOR_KEYS.length)],
                active: true
              });
            }
          }
          bubbles.current = [...newBubbles, ...bubbles.current];
          updateAvailableColors();
        }

        // Apply sway and update current visual position
        // Sway gets faster and wider as level increases
        const swaySpeed = 0.0008 + currentLevel * 0.0003;
        const swayAmp = 3 + currentLevel * 1.5;
        
        bubbles.current.forEach(b => {
          if (!b.active) return;
          const basePos = getBubblePos(b.row, b.col, canvas.width, yOffsetRef.current);
          b.x = basePos.x + Math.sin(time * swaySpeed + b.row) * swayAmp;
          b.y = basePos.y;
        });

        // Check for Game Over: if any bubble is below the threshold
        const gameOverThreshold = anchorPos.current.y - 70;
        const hasBreached = bubbles.current.some(b => b.active && b.y > gameOverThreshold);
        if (hasBreached) {
          isGameOverRef.current = true;
          setIsGameOver(true);
          // Auto-release pinch
          isPinching.current = false;
          ballPos.current = { ...anchorPos.current };
          ballVel.current = { x: 0, y: 0 };
        }
      }

      // --- Hand Tracking ---
      let handPos: Point | null = null;
      let pinchDist = 1.0;

      if (controlMode === 'webcam' && results && results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
        const landmarks = results.multiHandLandmarks[0];
        const idxTip = landmarks[8];
        const thumbTip = landmarks[4];

        handPos = {
          x: (idxTip.x * canvas.width + thumbTip.x * canvas.width) / 2,
          y: (idxTip.y * canvas.height + thumbTip.y * canvas.height) / 2
        };

        const dx = idxTip.x - thumbTip.x;
        const dy = idxTip.y - thumbTip.y;
        pinchDist = Math.sqrt(dx * dx + dy * dy);

        if (window.drawConnectors && window.drawLandmarks) {
           // Google Blue for tracking lines
           window.drawConnectors(ctx, landmarks, window.HAND_CONNECTIONS, {color: '#669df6', lineWidth: 1});
           window.drawLandmarks(ctx, landmarks, {color: '#aecbfa', lineWidth: 1, radius: 2});
        }
        
        // Cursor
        ctx.beginPath();
        ctx.arc(handPos.x, handPos.y, 20, 0, Math.PI * 2);
        ctx.strokeStyle = pinchDist < PINCH_THRESHOLD ? '#66bb6a' : '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      
      // --- SLINGSHOT LOGIC ---
      
      // Check if we are currently "Locked" waiting for AI
      const isLocked = isAiThinkingRef.current;

      if (controlMode === 'webcam' && !isPausedState) {
        if (!isLocked && handPos && pinchDist < PINCH_THRESHOLD && !isFlying.current) {
          const distToBall = Math.sqrt(Math.pow(handPos.x - ballPos.current.x, 2) + Math.pow(handPos.y - ballPos.current.y, 2));
          if (!isPinching.current && distToBall < 100) {
             isPinching.current = true;
          }
          
          if (isPinching.current) {
              ballPos.current = { x: handPos.x, y: handPos.y };
              const dragDx = ballPos.current.x - anchorPos.current.x;
              const dragDy = ballPos.current.y - anchorPos.current.y;
              const dragDist = Math.sqrt(dragDx*dragDx + dragDy*dragDy);
              
              if (dragDist > MAX_DRAG_DIST) {
                  const angle = Math.atan2(dragDy, dragDx);
                  ballPos.current.x = anchorPos.current.x + Math.cos(angle) * MAX_DRAG_DIST;
                  ballPos.current.y = anchorPos.current.y + Math.sin(angle) * MAX_DRAG_DIST;
              }
          }
        } 
        else if (isPinching.current && (!handPos || pinchDist >= PINCH_THRESHOLD || isLocked)) {
          // Release or Forced Release if Locked
          isPinching.current = false;
          
          if (isLocked) {
               // If we lock while pinching, reset to anchor
               ballPos.current = { ...anchorPos.current };
          } else {
              const dx = anchorPos.current.x - ballPos.current.x;
              const dy = anchorPos.current.y - ballPos.current.y;
              const stretchDist = Math.sqrt(dx*dx + dy*dy);
              
              if (stretchDist > 30) {
                  isFlying.current = true;
                  flightStartTime.current = performance.now();
                  const powerRatio = Math.min(stretchDist / MAX_DRAG_DIST, 1.0);
                  const velocityMultiplier = MIN_FORCE_MULT + (MAX_FORCE_MULT - MIN_FORCE_MULT) * (powerRatio * powerRatio);

                  ballVel.current = {
                      x: dx * velocityMultiplier,
                      y: dy * velocityMultiplier
                  };
              } else {
                  ballPos.current = { ...anchorPos.current };
              }
          }
        }
      }
      else if (!isFlying.current && !isPinching.current && !isPausedState) {
          const dx = anchorPos.current.x - ballPos.current.x;
          const dy = anchorPos.current.y - ballPos.current.y;
          ballPos.current.x += dx * 0.15;
          ballPos.current.y += dy * 0.15;
      }

      // --- Physics ---
      if (isFlying.current && !isPausedState) {
        // Infinite bounce safeguard: if flying for more than 5 seconds (5000ms), cancel shot
        if (performance.now() - flightStartTime.current > 5000) {
            isFlying.current = false;
            ballPos.current = { ...anchorPos.current };
            ballVel.current = { x: 0, y: 0 };
        } else {
            const currentSpeed = Math.sqrt(ballVel.current.x ** 2 + ballVel.current.y ** 2);
            const steps = Math.ceil(currentSpeed / (BUBBLE_RADIUS * 0.8)); 
            let collisionOccurred = false;

            for (let i = 0; i < steps; i++) {
                ballPos.current.x += ballVel.current.x / steps;
                ballPos.current.y += ballVel.current.y / steps;
                
                if (ballPos.current.x < BUBBLE_RADIUS || ballPos.current.x > canvas.width - BUBBLE_RADIUS) {
                    ballVel.current.x *= -1;
                    ballPos.current.x = Math.max(BUBBLE_RADIUS, Math.min(canvas.width - BUBBLE_RADIUS, ballPos.current.x));
                }

                if (ballPos.current.y < BUBBLE_RADIUS) {
                    collisionOccurred = true;
                    break;
                }

                for (const b of bubbles.current) {
                    if (!b.active) continue;
                    const dist = Math.sqrt(
                        Math.pow(ballPos.current.x - b.x, 2) + 
                        Math.pow(ballPos.current.y - b.y, 2)
                    );
                    if (dist < BUBBLE_RADIUS * 1.8) { 
                        collisionOccurred = true;
                        break;
                    }
                }
                if (collisionOccurred) break;
            }

            ballVel.current.y += GRAVITY; 
            ballVel.current.x *= FRICTION;
            ballVel.current.y *= FRICTION;

            if (collisionOccurred) {
                isFlying.current = false;
                
                let bestDist = Infinity;
                let bestRow = 0;
                let bestCol = 0;
                let bestX = 0;
                let bestY = 0;

                for (let r = 0; r < GRID_ROWS + 5; r++) {
                    const colsInRow = r % 2 !== 0 ? GRID_COLS - 1 : GRID_COLS;
                    for (let c = 0; c < colsInRow; c++) {
                        const { x, y } = getBubblePos(r, c, canvas.width, yOffsetRef.current);
                        const occupied = bubbles.current.some(b => b.active && b.row === r && b.col === c);
                        if (occupied) continue;

                        const dist = Math.sqrt(
                            Math.pow(ballPos.current.x - x, 2) + 
                            Math.pow(ballPos.current.y - y, 2)
                        );
                        
                        if (dist < bestDist) {
                            bestDist = dist;
                            bestRow = r;
                            bestCol = c;
                            bestX = x;
                            bestY = y;
                        }
                    }
                }

                const newBubble: Bubble = {
                    id: `${bestRow}-${bestCol}-${Date.now()}`,
                    row: bestRow,
                    col: bestCol,
                    x: bestX,
                    y: bestY,
                    color: selectedColorRef.current,
                    active: true
                };
                bubbles.current.push(newBubble);
                checkMatches(newBubble);
                updateAvailableColors();
                
                // Select a new projectile color randomly from active colors on the grid
                const activeColors = new Set<BubbleColor>();
                bubbles.current.forEach(b => {
                    if (b.active) activeColors.add(b.color);
                });
                const colorsList = Array.from(activeColors);
                if (colorsList.length > 0) {
                    const nextColor = colorsList[Math.floor(Math.random() * colorsList.length)];
                    setSelectedColor(nextColor);
                } else {
                    setSelectedColor(COLOR_KEYS[Math.floor(Math.random() * COLOR_KEYS.length)]);
                }

                // Reset shot
                ballPos.current = { ...anchorPos.current };
                ballVel.current = { x: 0, y: 0 };
            }
            
            if (ballPos.current.y > canvas.height) {
                isFlying.current = false;
                ballPos.current = { ...anchorPos.current };
                ballVel.current = { x: 0, y: 0 };
                
                // Select a new projectile color randomly from active colors on the grid
                const activeColors = new Set<BubbleColor>();
                bubbles.current.forEach(b => {
                    if (b.active) activeColors.add(b.color);
                });
                const colorsList = Array.from(activeColors);
                if (colorsList.length > 0) {
                    const nextColor = colorsList[Math.floor(Math.random() * colorsList.length)];
                    setSelectedColor(nextColor);
                }
            }
        }
      }

      // --- Drawing ---
      
      const currentSelected = selectedColorRef.current;

      // Draw Grid Bubbles
      bubbles.current.forEach(b => {
          if (!b.active) return;
          drawBubble(ctx, b.x, b.y, BUBBLE_RADIUS - 1, b.color);
      });

      // --- Player Aiming Trajectory & Dash Circle Preview ---
      if (isPinching.current) {
          const dx = anchorPos.current.x - ballPos.current.x;
          const dy = anchorPos.current.y - ballPos.current.y;
          const stretchDist = Math.sqrt(dx * dx + dy * dy);
          
          if (stretchDist > 20) {
              const powerRatio = Math.min(stretchDist / MAX_DRAG_DIST, 1.0);
              const velocityMultiplier = MIN_FORCE_MULT + (MAX_FORCE_MULT - MIN_FORCE_MULT) * (powerRatio * powerRatio);
              
              const startVel = {
                  x: dx * velocityMultiplier,
                  y: dy * velocityMultiplier
              };
              
              const { pathPoints, lastPos, collisionOccurred } = getTrajectory(
                  ballPos.current,
                  startVel,
                  bubbles.current,
                  canvas.width
              );
              
              ctx.save();
              const themeColor = COLOR_CONFIG[currentSelected].hex;
              
              // Draw the dashed trajectory line
              ctx.beginPath();
              ctx.moveTo(pathPoints[0].x, pathPoints[0].y);
              for (let i = 1; i < pathPoints.length; i++) {
                  ctx.lineTo(pathPoints[i].x, pathPoints[i].y);
              }
              
              ctx.strokeStyle = themeColor;
              ctx.lineWidth = 3;
              ctx.setLineDash([8, 6]);
              const time = performance.now();
              ctx.lineDashOffset = -(time / 15) % 28;
              ctx.shadowBlur = 10;
              ctx.shadowColor = themeColor;
              ctx.stroke();
              ctx.restore();
              
              // Draw predicted landing bubble as a dashed preview circle
              if (collisionOccurred) {
                  let bestDist = Infinity;
                  let bestRow = 0;
                  let bestCol = 0;
                  let bestX = 0;
                  let bestY = 0;
                  
                  for (let r = 0; r < GRID_ROWS + 5; r++) {
                      const colsInRow = r % 2 !== 0 ? GRID_COLS - 1 : GRID_COLS;
                      for (let c = 0; c < colsInRow; c++) {
                          const { x, y } = getBubblePos(r, c, canvas.width, yOffsetRef.current);
                          const occupied = bubbles.current.some(b => b.active && b.row === r && b.col === c);
                          if (occupied) continue;
                          
                          const dist = Math.sqrt(
                              Math.pow(lastPos.x - x, 2) + 
                              Math.pow(lastPos.y - y, 2)
                          );
                          
                          if (dist < bestDist) {
                              bestDist = dist;
                              bestRow = r;
                              bestCol = c;
                              bestX = x;
                              bestY = y;
                          }
                      }
                  }
                  
                  // Draw a dashed circle preview at (bestX, bestY)
                  ctx.save();
                  ctx.beginPath();
                  ctx.arc(bestX, bestY, BUBBLE_RADIUS - 1, 0, Math.PI * 2);
                  ctx.strokeStyle = themeColor;
                  ctx.lineWidth = 2.5;
                  ctx.setLineDash([6, 4]);
                  ctx.lineDashOffset = (time / 10) % 20;
                  ctx.shadowBlur = 12;
                  ctx.shadowColor = themeColor;
                  ctx.stroke();
                  
                  // Draw a semi-transparent fill body
                  ctx.fillStyle = `${themeColor}28`; // ~15% opacity
                  ctx.fill();
                  
                  // Add a subtle target marker inside the circle
                  ctx.beginPath();
                  ctx.arc(bestX, bestY, 3, 0, Math.PI * 2);
                  ctx.fillStyle = themeColor;
                  ctx.fill();
                  ctx.restore();
              }
          }
      }

      // Laser Sight (AI Strategic Hint Line)
      const currentAimTarget = aimTargetRef.current;
      const thinking = isAiThinkingRef.current;
      const shouldShowLine = currentAimTarget && !isFlying.current && !isPinching.current &&
                             (!aiRecommendedColor || aiRecommendedColor === currentSelected);

      if ((shouldShowLine || thinking) && !isPinching.current) {
          ctx.save();
          const highlightColor = thinking ? '#a8c7fa' : COLOR_CONFIG[currentSelected].hex; 
          
          ctx.shadowBlur = 15;
          ctx.shadowColor = highlightColor;
          
          ctx.beginPath();
          ctx.moveTo(anchorPos.current.x, anchorPos.current.y);
          if (currentAimTarget) {
            ctx.lineTo(currentAimTarget.x, currentAimTarget.y);
          } else {
            ctx.lineTo(anchorPos.current.x, anchorPos.current.y - 200);
          }
          
          const time = performance.now();
          const dashOffset = (time / 15) % 30;
          ctx.setLineDash([20, 15]);
          ctx.lineDashOffset = -dashOffset;
          
          ctx.strokeStyle = thinking ? 'rgba(168, 199, 250, 0.5)' : highlightColor;
          ctx.lineWidth = 4;
          ctx.stroke();
          
          if (currentAimTarget && !thinking) {
              ctx.beginPath();
              ctx.arc(currentAimTarget.x, currentAimTarget.y, BUBBLE_RADIUS, 0, Math.PI * 2);
              ctx.setLineDash([5, 5]);
              ctx.strokeStyle = highlightColor;
              ctx.fillStyle = 'rgba(255,255,255,0.1)';
              ctx.fill();
              ctx.stroke();
          }
          
          ctx.restore();
      }
      
      // Removed Canvas "ANALYZING..." drawing code from here

      // Slingshot Band (Back)
      const bandColor = isPinching.current ? '#fdd835' : 'rgba(255,255,255,0.4)';
      if (!isFlying.current) {
        ctx.beginPath();
        ctx.moveTo(anchorPos.current.x - 35, anchorPos.current.y - 10);
        ctx.lineTo(ballPos.current.x, ballPos.current.y);
        ctx.lineWidth = 5;
        ctx.strokeStyle = bandColor;
        ctx.lineCap = 'round';
        ctx.stroke();
      }

      // Draw Slingshot Ball (Projectile)
      // If locked, we draw it slightly faded to indicate inactivity
      ctx.save();
      if (isLocked && !isFlying.current) {
          ctx.globalAlpha = 0.5;
      }
      drawBubble(ctx, ballPos.current.x, ballPos.current.y, BUBBLE_RADIUS, selectedColorRef.current);
      ctx.restore();

      // Slingshot Band (Front)
      if (!isFlying.current) {
        ctx.beginPath();
        ctx.moveTo(ballPos.current.x, ballPos.current.y);
        ctx.lineTo(anchorPos.current.x + 35, anchorPos.current.y - 10);
        ctx.lineWidth = 5;
        ctx.strokeStyle = bandColor;
        ctx.lineCap = 'round';
        ctx.stroke();
      }

      // Slingshot Handle
      ctx.beginPath();
      ctx.moveTo(anchorPos.current.x, canvas.height); 
      ctx.lineTo(anchorPos.current.x, anchorPos.current.y + 40); 
      ctx.lineTo(anchorPos.current.x - 40, anchorPos.current.y); 
      ctx.moveTo(anchorPos.current.x, anchorPos.current.y + 40);
      ctx.lineTo(anchorPos.current.x + 40, anchorPos.current.y); 
      ctx.lineWidth = 10;
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#616161';
      ctx.stroke();

      // Particles
      for (let i = particles.current.length - 1; i >= 0; i--) {
          const p = particles.current[i];
          if (!isPausedState) {
              p.x += p.vx;
              p.y += p.vy;
              p.life -= 0.05;
          }
          if (p.life <= 0) particles.current.splice(i, 1);
          else {
              ctx.globalAlpha = p.life;
              ctx.beginPath();
              ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
              ctx.fillStyle = p.color;
              ctx.fill();
              ctx.globalAlpha = 1.0;
          }
      }
      
      ctx.restore();

      // --- CAPTURE SCREENSHOT IF REQUESTED ---
      // We do this at the end of the render loop to ensure everything is drawn
      if (captureRequestRef.current) {
        captureRequestRef.current = false;
        
        // --- OPTIMIZATION: Resize & Compress Image before sending ---
        const offscreen = document.createElement('canvas');
        const targetWidth = 480; // Small width is sufficient for color/layout analysis
        const scale = Math.min(1, targetWidth / canvas.width);
        
        offscreen.width = canvas.width * scale;
        offscreen.height = canvas.height * scale;
        
        const oCtx = offscreen.getContext('2d');
        if (oCtx) {
            oCtx.drawImage(canvas, 0, 0, offscreen.width, offscreen.height);
            // Use JPEG at 0.6 quality for faster upload/processing
            const screenshot = offscreen.toDataURL("image/jpeg", 0.6);
            
            // Send to AI (non-blocking for render loop, but locks game logic)
            setTimeout(() => performAiAnalysis(screenshot), 0);
        }
      }
    };

    let mouseLoopId: number;

    if (controlMode === 'mouse') {
      const runMouseLoop = () => {
        onResults(null);
        mouseLoopId = requestAnimationFrame(runMouseLoop);
      };
      runMouseLoop();
    } else {
      if (window.Hands) {
        if (!globalHands) {
          globalHands = new window.Hands({
            locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4/${file}`,
          });
          globalHands.setOptions({
            maxNumHands: 1,
            modelComplexity: 1,
            minDetectionConfidence: 0.5,
            minTrackingConfidence: 0.5,
          });
        }
        hands = globalHands;
        hands.onResults(onResults);
        
        if (window.Camera) {
          camera = new window.Camera(video, {
            onFrame: async () => {
              if (videoRef.current && globalHands && controlMode === 'webcam') {
                try {
                  await globalHands.send({ image: videoRef.current });
                } catch (err: any) {
                  console.error("Error sending image to globalHands:", err);
                  const errMsg = err?.message || String(err);
                  if (errMsg.includes("Aborted") || errMsg.includes("arguments has been replaced")) {
                    console.warn("MediaPipe Hands aborted. Resetting global instance...");
                    try {
                      globalHands.close();
                    } catch (e) {}
                    globalHands = null;
                  }
                }
              }
            },
            width: 1280,
            height: 720,
          });
          camera.start();
        }
      }
    }

    return () => {
        if (mouseLoopId) {
          cancelAnimationFrame(mouseLoopId);
        }
        if (camera) {
          try {
            camera.stop();
          } catch (err) {
            console.error("Error stopping camera:", err);
          }
        }
    };
  }, [initGrid, gameStarted, controlMode]);

  const recColorConfig = aiRecommendedColor ? COLOR_CONFIG[aiRecommendedColor] : null;
  const borderColor = recColorConfig ? recColorConfig.hex : '#444746';

  return (
    <div className="flex w-full h-screen bg-[#121212] overflow-hidden font-roboto text-[#e3e3e3]">
      
      {/* MOBILE/TABLET BLOCKER OVERLAY */}
      <div className="fixed inset-0 z-[100] bg-[#121212] flex flex-col items-center justify-center p-8 text-center md:hidden">
         <Monitor className="w-16 h-16 text-[#ef5350] mb-6 animate-pulse" />
         <h2 className="text-2xl font-bold text-[#e3e3e3] mb-4">Desktop View Required</h2>
         <p className="text-[#c4c7c5] max-w-md text-lg leading-relaxed">
           This experience requires a larger screen for the webcam tracking and game mechanics.
         </p>
         <div className="mt-8 flex items-center gap-2 text-sm text-[#757575] uppercase tracking-wider font-bold">
           <div className="w-2 h-2 bg-[#42a5f5] rounded-full"></div>
           Please maximize window
         </div>
      </div>

      {/* LEFT: Game Area */}
      <div ref={gameContainerRef} className="flex-1 relative h-full overflow-hidden">
        <video ref={videoRef} className="absolute hidden" playsInline />
        <canvas 
          ref={canvasRef} 
          className="absolute inset-0 cursor-grab active:cursor-grabbing touch-none" 
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        />

        {/* Start Screen Overlay */}
        {!gameStarted && (
          <div className="absolute inset-0 bg-[#121212] z-50 flex flex-col items-center justify-center p-6 text-center overflow-y-auto">
            <div className="max-w-2xl w-full bg-[#1e1e1e] border-2 border-[#42a5f5]/30 rounded-[36px] p-8 md:p-12 shadow-[0_0_50px_rgba(66,165,245,0.15)] relative overflow-hidden flex flex-col items-center">
              {/* Background gradient flares */}
              <div className="absolute -top-24 -left-24 w-64 h-64 bg-[#42a5f5]/10 rounded-full blur-3xl pointer-events-none" />
              <div className="absolute -bottom-24 -right-24 w-64 h-64 bg-[#ab47bc]/10 rounded-full blur-3xl pointer-events-none" />

              {/* Icon / Brand badge */}
              <div className="relative mb-6 animate-pulse">
                <div className="absolute inset-0 bg-gradient-to-r from-[#42a5f5] to-[#ab47bc] rounded-full blur-xl opacity-60 scale-125" />
                <div className="bg-gradient-to-r from-[#42a5f5] to-[#ab47bc] p-4 rounded-full relative z-10 border border-white/10">
                  <BrainCircuit className="w-12 h-12 text-white" />
                </div>
              </div>

              {/* Title */}
              <h1 className="text-4xl md:text-5xl font-black tracking-wider text-white mb-3">
                GEMINI <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#42a5f5] to-[#ab47bc]">SLINGSHOT</span>
              </h1>
              <p className="text-[#c4c7c5] text-sm md:text-base max-w-lg leading-relaxed mb-8 font-medium">
                สัมผัสประสบการณ์เกมยิงฟองสบู่รูปแบบใหม่! ควบคุมหนังสติ๊กด้วยท่าทางมือผ่านกล้องของคุณ และรับคำแนะนำระดับอัจฉริยะจาก AI ในทุกขั้นตอน
              </p>

              {/* Features / Instructions Grid */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 w-full mb-8 text-left">
                <div className="bg-black/30 p-5 rounded-2xl border border-gray-800/80 hover:border-gray-700 transition-all">
                  <div className="bg-[#42a5f5]/10 w-8 h-8 rounded-lg flex items-center justify-center mb-3">
                    <Target className="w-5 h-5 text-[#42a5f5]" />
                  </div>
                  <h3 className="text-sm font-bold text-white mb-1.5">1. คีบและดึง</h3>
                  <p className="text-xs text-gray-400 leading-relaxed">
                    ใช้ปลายนิ้วชี้และนิ้วโป้งจีบเข้าหากันบนหน้าจอเพื่อดึงสลิงชอต และปล่อยมือเพื่อยิงฟอง!
                  </p>
                </div>

                <div className="bg-black/30 p-5 rounded-2xl border border-gray-800/80 hover:border-gray-700 transition-all">
                  <div className="bg-[#ab47bc]/10 w-8 h-8 rounded-lg flex items-center justify-center mb-3">
                    <Sparkles className="w-5 h-5 text-[#ab47bc]" />
                  </div>
                  <h3 className="text-sm font-bold text-white mb-1.5">2. กลยุทธ์ AI</h3>
                  <p className="text-xs text-gray-400 leading-relaxed">
                    Gemini AI จะช่วยแนะนำสีของฟองสบู่ และพิกัดเป้าหมายการยิงที่ดีที่สุดเพื่อเอาชนะเกม
                  </p>
                </div>

                <div className="bg-black/30 p-5 rounded-2xl border border-gray-800/80 hover:border-gray-700 transition-all">
                  <div className="bg-[#ffee58]/10 w-8 h-8 rounded-lg flex items-center justify-center mb-3">
                    <Trophy className="w-5 h-5 text-[#ffee58]" />
                  </div>
                  <h3 className="text-sm font-bold text-white mb-1.5">3. ระดับความท้าทาย</h3>
                  <p className="text-xs text-gray-400 leading-relaxed">
                    ทุกครั้งที่คุณยิงฟองได้ครบ ยอดความเร็วและความหนาแน่นจะเพิ่มขึ้นเพื่อความตื่นเต้น!
                  </p>
                </div>
              </div>

              {/* Google login encouragement / status in start screen */}
              {!currentUser ? (
                <div className="mb-8 w-full max-w-sm flex flex-col items-center gap-2 bg-black/20 p-4 rounded-2xl border border-gray-800">
                  <p className="text-xs text-gray-400">เข้าสู่ระบบเพื่อบันทึกคะแนนสูงสุดของคุณบนลีดเดอร์บอร์ดระดับโลก!</p>
                  <button 
                    onClick={signInWithGoogle}
                    className="flex items-center justify-center gap-2 bg-[#1e1e1e] hover:bg-[#252525] border border-[#444746] text-white py-2 px-4 rounded-xl text-xs font-bold transition-all"
                  >
                    <User className="w-4 h-4 text-[#42a5f5]" />
                    เชื่อมต่อด้วยบัญชี Google
                  </button>
                </div>
              ) : (
                <div className="mb-8 flex items-center gap-2 bg-[#66bb6a]/10 px-4 py-2 rounded-full border border-[#66bb6a]/30 text-[#66bb6a] text-xs font-bold">
                  <User className="w-4 h-4" />
                  พร้อมเล่นแล้ว: {currentUser.displayName || 'Player'}
                </div>
              )}

              {/* Control Mode Selector */}
              <div className="w-full max-w-md mb-8 relative z-20">
                <p className="text-xs text-gray-400 font-bold uppercase tracking-wider text-center mb-3">
                  เลือกรูปแบบการควบคุม (Control Method)
                </p>
                <div className="grid grid-cols-2 gap-3 bg-black/40 p-1.5 rounded-2xl border border-gray-800">
                  <button
                    onClick={() => setControlMode('webcam')}
                    className={`flex flex-col items-center justify-center py-3.5 px-4 rounded-xl transition-all ${
                      controlMode === 'webcam'
                        ? 'bg-gradient-to-r from-[#42a5f5]/20 to-[#42a5f5]/10 border-2 border-[#42a5f5] text-white'
                        : 'bg-transparent border-2 border-transparent text-gray-500 hover:text-gray-300'
                    }`}
                  >
                    <Video className="w-6 h-6 mb-1.5" />
                    <span className="text-xs font-bold text-center">กล้อง Webcam (ท่าทางมือ)</span>
                    <span className="text-[10px] text-gray-400 mt-0.5 text-center">คีบนิ้วเพื่อยิงฟอง</span>
                  </button>

                  <button
                    onClick={() => setControlMode('mouse')}
                    className={`flex flex-col items-center justify-center py-3.5 px-4 rounded-xl transition-all ${
                      controlMode === 'mouse'
                        ? 'bg-gradient-to-r from-[#ab47bc]/20 to-[#ab47bc]/10 border-2 border-[#ab47bc] text-white'
                        : 'bg-transparent border-2 border-transparent text-gray-500 hover:text-gray-300'
                    }`}
                  >
                    <MousePointer className="w-6 h-6 mb-1.5" />
                    <span className="text-xs font-bold text-center">เมาส์หรือสัมผัส (Mouse)</span>
                    <span className="text-[10px] text-gray-400 mt-0.5 text-center">ลากหนังสติ๊กแล้วปล่อย</span>
                  </button>
                </div>
              </div>

              {/* Play Button */}
              <button
                onClick={() => {
                  setGameStarted(true);
                  if (controlMode === 'webcam') {
                    setLoading(true);
                  } else {
                    setLoading(false);
                  }
                }}
                className="bg-gradient-to-r from-[#42a5f5] to-[#ab47bc] hover:from-[#1e88e5] hover:to-[#8e24aa] text-white font-bold py-4 px-10 rounded-2xl text-lg transition-all duration-300 shadow-[0_0_30px_rgba(66,165,245,0.3)] hover:shadow-[0_0_40px_rgba(171,71,188,0.5)] transform hover:scale-105 active:scale-95 flex items-center gap-2"
              >
                <Play className="w-5 h-5 fill-current" />
                {controlMode === 'webcam' ? 'เปิดกล้องและเริ่มเล่นเกม' : 'เริ่มเล่นเกม (โหมดเมาส์)'}
              </button>
            </div>
          </div>
        )}

        {/* Loading Overlay */}
        {loading && gameStarted && (
            <div className="absolute inset-0 flex items-center justify-center bg-[#121212] z-50">
            <div className="flex flex-col items-center">
                <Loader2 className="w-12 h-12 text-[#42a5f5] animate-spin mb-4" />
                <p className="text-[#e3e3e3] text-lg font-medium">Starting Engine...</p>
            </div>
            </div>
        )}

        {/* Analyzing Overlay - positioned at Slingshot Anchor */}
        {isAiThinking && (
          <div 
            className="absolute left-1/2 -translate-x-1/2 z-50 flex flex-col items-center justify-center pointer-events-none"
            style={{ bottom: '220px', transform: 'translate(-50%, 50%)' }}
          >
             <div className="w-[72px] h-[72px] rounded-full border-4 border-t-[#a8c7fa] border-r-[#a8c7fa] border-b-transparent border-l-transparent animate-spin" />
             <p className="mt-4 text-[#a8c7fa] font-bold text-xs tracking-widest animate-pulse">ANALYZING...</p>
          </div>
        )}

        {/* HUD: Score Card */}
        <div className="absolute top-6 left-6 z-40">
            <div className="bg-[#1e1e1e] p-5 rounded-[28px] border border-[#444746] shadow-2xl flex items-center gap-4 min-w-[180px]">
                <div className="bg-[#42a5f5]/20 p-3 rounded-full">
                    <Trophy className="w-6 h-6 text-[#42a5f5]" />
                </div>
                <div>
                    <p className="text-xs text-[#c4c7c5] uppercase tracking-wider font-medium">Score</p>
                    <p className="text-3xl font-bold text-white">{score.toLocaleString()}</p>
                </div>
            </div>
        </div>

        {/* HUD: Progression Card */}
        <div className="absolute top-6 left-[214px] z-40">
            <div className="bg-[#1e1e1e] px-5 py-3 rounded-[28px] border border-[#444746] shadow-2xl flex flex-col gap-1 min-w-[200px]">
                <div className="flex items-center gap-2">
                    <div className="bg-[#ab47bc]/20 p-2 rounded-full">
                        <Sparkles className="w-4 h-4 text-[#ab47bc]" />
                    </div>
                    <div>
                        <p className="text-[10px] text-[#c4c7c5] uppercase tracking-wider font-medium">Difficulty Level</p>
                        <p className="text-sm font-bold text-white">Level {level}</p>
                    </div>
                </div>
                <div className="mt-1">
                    <div className="flex justify-between text-[9px] text-[#c4c7c5] mb-1 font-bold">
                        <span>Pops: {totalPops}</span>
                        <span>Next Level: {12 - (totalPops % 12)} pops</span>
                    </div>
                    <div className="w-full bg-[#2a2a2a] h-1.5 rounded-full overflow-hidden">
                        <div 
                          className="bg-gradient-to-r from-[#ab47bc] to-[#42a5f5] h-full transition-all duration-300"
                          style={{ width: `${((totalPops % 12) / 12) * 100}%` }}
                        />
                    </div>
                    <div className="flex justify-between text-[8px] text-gray-500 mt-1 font-mono">
                        <span>Speed: {(0.02 + level * 0.015).toFixed(3)} px/f</span>
                        <span>Density: {Math.round(Math.min(40 + level * 8, 90))}%</span>
                    </div>
                </div>
            </div>
        </div>

        {/* LEVEL UP CELEBRATION OVERLAY */}
        {levelUpFlash && (
          <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 z-40 pointer-events-none animate-bounce">
            <div className="bg-gradient-to-r from-[#42a5f5] to-[#ab47bc] px-8 py-4 rounded-[24px] shadow-[0_0_30px_rgba(66,165,245,0.5)] border-2 border-white/20 text-center">
              <Sparkles className="w-8 h-8 text-white mx-auto mb-1 animate-pulse" />
              <h2 className="text-3xl font-black text-white tracking-widest drop-shadow-md">LEVEL UP!</h2>
              <p className="text-white/90 text-xs uppercase font-bold tracking-wider">Now entering Level {level}</p>
            </div>
          </div>
        )}

        {/* GAME OVER OVERLAY */}
        {isGameOver && (
          <div className="absolute inset-0 bg-black/80 backdrop-blur-sm z-50 flex flex-col items-center justify-center p-6 text-center">
            <div className="bg-[#1e1e1e] border-2 border-[#ef5350] rounded-[32px] p-8 max-w-md w-full shadow-2xl relative overflow-hidden">
              <div className="absolute -top-10 -left-10 w-40 h-40 bg-[#ef5350]/10 rounded-full blur-3xl" />
              <div className="absolute -bottom-10 -right-10 w-40 h-40 bg-[#42a5f5]/10 rounded-full blur-3xl" />
              
              <AlertTriangle className="w-16 h-16 text-[#ef5350] mx-auto mb-4 animate-bounce" />
              <h2 className="text-3xl font-black tracking-wider text-white mb-2">GAME OVER</h2>
              <p className="text-gray-400 text-sm mb-6">The bubbles breached the defensive line! Excellent effort, player.</p>
              
              <div className="grid grid-cols-2 gap-4 mb-6">
                <div className="bg-black/40 p-4 rounded-2xl border border-gray-800">
                  <p className="text-[10px] text-gray-500 uppercase font-bold tracking-wider">Final Score</p>
                  <p className="text-2xl font-mono font-bold text-[#42a5f5]">{score.toLocaleString()}</p>
                </div>
                <div className="bg-black/40 p-4 rounded-2xl border border-gray-800">
                  <p className="text-[10px] text-gray-500 uppercase font-bold tracking-wider">Pops Count</p>
                  <p className="text-2xl font-mono font-bold text-[#66bb6a]">{totalPops.toLocaleString()}</p>
                </div>
              </div>

              <div className="bg-black/20 p-4 rounded-xl border border-gray-800/50 mb-6 text-center">
                <p className="text-xs text-gray-400">Reached Level</p>
                <p className="text-xl font-bold text-white">Level {level}</p>
              </div>

              <button
                onClick={resetGame}
                className="w-full bg-[#ef5350] hover:bg-[#d32f2f] text-white py-3 px-6 rounded-xl text-base font-bold transition-all shadow-lg active:scale-95 flex items-center justify-center gap-2"
              >
                <Play className="w-5 h-5 fill-current" />
                Play Again
              </button>
            </div>
          </div>
        )}

        {/* GAME PAUSED OVERLAY */}
        {isPaused && (
          <div className="absolute inset-0 bg-black/85 backdrop-blur-sm z-50 flex flex-col items-center justify-center p-6 text-center animate-fade-in">
            <div className="bg-[#1e1e1e] border-2 border-[#42a5f5] rounded-[32px] p-8 max-w-sm w-full shadow-[0_0_50px_rgba(66,165,245,0.25)] relative overflow-hidden">
              <div className="absolute -top-10 -left-10 w-40 h-40 bg-[#42a5f5]/10 rounded-full blur-3xl pointer-events-none" />
              <div className="absolute -bottom-10 -right-10 w-40 h-40 bg-[#ab47bc]/10 rounded-full blur-3xl pointer-events-none" />
              
              <Pause className="w-16 h-16 text-[#42a5f5] mx-auto mb-4 animate-pulse" />
              <h2 className="text-3xl font-black tracking-wider text-white mb-2 uppercase">Game Paused</h2>
              <p className="text-gray-400 text-sm mb-6">Take a breath, adjust your strategy, and jump right back in!</p>
              
              <div className="flex flex-col gap-3.5">
                <button
                  id="resume-btn"
                  onClick={() => {
                    setIsPaused(false);
                    isPausedRef.current = false;
                  }}
                  className="w-full bg-[#42a5f5] hover:bg-[#1e88e5] text-white py-3 px-6 rounded-xl text-base font-bold transition-all shadow-lg active:scale-95 flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Play className="w-5 h-5 fill-current" />
                  Resume Game
                </button>

                <button
                  id="restart-btn"
                  onClick={() => {
                    resetGame();
                    setIsPaused(false);
                    isPausedRef.current = false;
                  }}
                  className="w-full bg-[#2a2a2a] hover:bg-[#333333] border border-gray-800 text-gray-200 py-3 px-6 rounded-xl text-base font-bold transition-all active:scale-95 flex items-center justify-center gap-2 cursor-pointer"
                >
                  <RotateCcw className="w-5 h-5" />
                  Restart Level
                </button>

                <button
                  id="quit-btn"
                  onClick={() => {
                    resetGame();
                    setGameStarted(false);
                    setIsPaused(false);
                    isPausedRef.current = false;
                  }}
                  className="w-full bg-[#1c1c1c] hover:bg-[#ef5350]/10 border border-[#ef5350]/30 hover:border-[#ef5350] text-gray-400 hover:text-white py-3 px-6 rounded-xl text-base font-bold transition-all active:scale-95 flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Home className="w-5 h-5" />
                  Quit to Start Menu
                </button>
              </div>

              <p className="text-[10px] text-gray-500 font-mono mt-6 uppercase tracking-widest">Press ESC to Resume</p>
            </div>
          </div>
        )}

        {/* HUD: Color Picker */}
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-40">
            <div className="bg-[#1e1e1e] px-6 py-4 rounded-[32px] border border-[#444746] shadow-2xl flex items-center gap-4">
                <p className="text-xs text-[#c4c7c5] uppercase font-bold tracking-wider mr-2 hidden md:block">Select Color</p>
                {availableColors.length === 0 ? (
                    <p className="text-sm text-gray-500">No ammo</p>
                ) : (
                    COLOR_KEYS.filter(c => availableColors.includes(c)).map(color => {
                        const isSelected = selectedColor === color;
                        const isRecommended = aiRecommendedColor === color;
                        const config = COLOR_CONFIG[color];
                        
                        return (
                            <button
                                key={color}
                                onClick={() => setSelectedColor(color)}
                                className={`relative w-14 h-14 rounded-full transition-all duration-300 transform flex items-center justify-center
                                    ${isSelected ? 'scale-110 ring-4 ring-white/50 z-10' : 'opacity-80 hover:opacity-100 hover:scale-105'}
                                `}
                                style={{ 
                                    background: `radial-gradient(circle at 35% 35%, ${config.hex}, ${adjustColor(config.hex, -60)})`,
                                    boxShadow: isSelected 
                                        ? `0 0 20px ${config.hex}, inset 0 -4px 4px rgba(0,0,0,0.3)`
                                        : '0 4px 6px rgba(0,0,0,0.3), inset 0 -4px 4px rgba(0,0,0,0.3)'
                                }}
                            >
                                {/* Glossy highlight for button */}
                                <div className="absolute top-2 left-3 w-4 h-2 bg-white/40 rounded-full transform -rotate-45 filter blur-[1px]" />
                                
                                {isRecommended && !isSelected && (
                                    <span className="absolute -top-1 -right-1 w-5 h-5 bg-white text-black text-[10px] font-bold flex items-center justify-center rounded-full animate-bounce shadow-md">!</span>
                                )}
                                {isSelected && (
                                    <MousePointerClick className="w-6 h-6 text-white/90 drop-shadow-md" />
                                )}
                            </button>
                        )
                    })
                )}
            </div>
        </div>

        {/* Bottom Tip */}
        {!isPinching.current && !isFlying.current && !isAiThinking && (
            <div className="absolute bottom-28 left-1/2 -translate-x-1/2 z-30 pointer-events-none opacity-50">
                <div className="flex items-center gap-2 bg-[#1e1e1e]/90 px-4 py-2 rounded-full border border-[#444746] backdrop-blur-sm">
                    <Play className="w-3 h-3 text-[#42a5f5] fill-current" />
                    <p className="text-[#e3e3e3] text-xs font-medium">Pinch & Pull to Shoot</p>
                </div>
            </div>
        )}
      </div>

      {/* RIGHT: Debug Panel */}
      <div className="w-[380px] bg-[#1e1e1e] border-l border-[#444746] flex flex-col h-full overflow-hidden shadow-2xl">
        
        {/* FLASH STRATEGY SECTION - PROMINENT */}
        <div className="px-5 pt-5 pb-0 bg-[#252525] border-t border-gray-800">
          <button
            onClick={() => {
              captureRequestRef.current = true;
            }}
            disabled={isAiThinking || isFlying.current || !gameStarted}
            className="w-full py-2.5 px-4 bg-gradient-to-r from-[#42a5f5] to-[#ab47bc] hover:from-[#1e88e5] hover:to-[#8e24aa] disabled:from-gray-800/80 disabled:to-gray-800/80 text-white font-bold text-xs rounded-xl flex items-center justify-center gap-2 transition-all shadow-md active:scale-95 cursor-pointer disabled:cursor-not-allowed"
          >
            {isAiThinking ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin text-white" />
                กำลังวิเคราะห์ด้วย AI...
              </>
            ) : (
              <>
                <BrainCircuit className="w-4 h-4 text-white" />
                วิเคราะห์กลยุทธ์ด้วย Gemini AI
              </>
            )}
          </button>
        </div>
        <div 
            className="p-5 border-b-4 transition-colors duration-500 flex flex-col gap-2"
            style={{ 
                backgroundColor: '#252525',
                borderColor: borderColor
            }}
        >
             <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <BrainCircuit className="w-5 h-5" style={{ color: borderColor }} />
                    <h2 className="font-bold text-sm tracking-widest uppercase" style={{ color: borderColor }}>
                        Flash Strategy
                    </h2>
                </div>
                {isAiThinking && <Loader2 className="w-4 h-4 animate-spin text-white/50" />}
             </div>
             
             <p className="text-[#e3e3e3] text-sm leading-relaxed font-bold">
                {aiHint}
             </p>
             
             {aiRationale && (
                 <div className="flex gap-2 mt-1">
                     <Lightbulb className="w-4 h-4 text-[#a8c7fa] shrink-0 mt-0.5" />
                     <p className="text-[#a8c7fa] text-xs italic opacity-90 leading-tight">
                        {aiRationale}
                     </p>
                 </div>
             )}
             
             {aiRecommendedColor && (
                <div className="flex items-center gap-2 mt-3 bg-black/20 p-2 rounded">
                    <Target className="w-4 h-4 text-gray-400" />
                    <span className="text-xs text-gray-400 uppercase tracking-wide">Rec. Color:</span>
                    <span className="text-xs font-bold uppercase" style={{ color: COLOR_CONFIG[aiRecommendedColor].hex }}>
                        {COLOR_CONFIG[aiRecommendedColor].label}
                    </span>
                </div>
             )}
        </div>

        {/* TABS CONTAINER */}
        <div className="flex border-b border-[#444746] bg-[#1a1a1a]">
          <button 
            onClick={() => setActiveTab('leaderboard')}
            className={`flex-1 py-3 text-xs font-bold uppercase tracking-wider flex items-center justify-center gap-2 border-b-2 transition-all
              ${activeTab === 'leaderboard' ? 'text-[#42a5f5] border-[#42a5f5] bg-[#222]' : 'text-gray-400 border-transparent hover:text-white'}`}
          >
            <Trophy className="w-4 h-4 text-[#42a5f5]" />
            Leaderboard
          </button>
          <button 
            onClick={() => setActiveTab('debug')}
            className={`flex-1 py-3 text-xs font-bold uppercase tracking-wider flex items-center justify-center gap-2 border-b-2 transition-all
              ${activeTab === 'debug' ? 'text-[#a8c7fa] border-[#a8c7fa] bg-[#222]' : 'text-gray-400 border-transparent hover:text-white'}`}
          >
            <Terminal className="w-4 h-4 text-[#a8c7fa]" />
            AI Debugger
          </button>
        </div>

        {activeTab === 'leaderboard' ? (
          <div className="flex-1 overflow-y-auto p-5 space-y-6">
            {/* User Profile Auth Section */}
            <div className="bg-[#252525] p-4 rounded-2xl border border-[#444746] shadow-md">
              {!currentUser ? (
                <div className="text-center py-3">
                  <p className="text-xs text-gray-400 mb-3">Sign in with Google to save your high scores and compete on the global leaderboard!</p>
                  <button 
                    onClick={handleLogin}
                    className="w-full flex items-center justify-center gap-2 bg-[#42a5f5] hover:bg-[#1e88e5] text-white py-2.5 px-4 rounded-xl text-sm font-bold transition-all shadow-lg active:scale-95"
                  >
                    <User className="w-4 h-4" />
                    Sign In with Google
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="bg-[#42a5f5]/10 p-2 rounded-full">
                        <User className="w-4 h-4 text-[#42a5f5]" />
                      </div>
                      <div className="text-left">
                        <p className="text-xs text-gray-400 uppercase tracking-wide">Player</p>
                        <p className="text-sm font-bold text-white max-w-[150px] truncate">{currentUser.displayName || 'Player'}</p>
                      </div>
                    </div>
                    <button 
                      onClick={handleLogout}
                      className="p-2 text-gray-400 hover:text-[#ef5350] rounded-lg transition-all"
                      title="Sign Out"
                    >
                      <LogOut className="w-4 h-4" />
                    </button>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-2 pt-2 border-t border-gray-700/50">
                    <div className="bg-black/20 p-2 rounded-lg">
                      <p className="text-[10px] text-gray-400 uppercase">Your Top Score</p>
                      <p className="text-lg font-mono font-bold text-[#66bb6a]">
                        {(firebaseProfile?.highScore || 0).toLocaleString()}
                      </p>
                    </div>
                    <div className="bg-black/20 p-2 rounded-lg relative overflow-hidden">
                      <p className="text-[10px] text-gray-400 uppercase">Current Run</p>
                      <p className="text-lg font-mono font-bold text-white">
                        {score.toLocaleString()}
                      </p>
                      {isSyncingScore && (
                        <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                          <Loader2 className="w-4 h-4 animate-spin text-[#42a5f5]" />
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Global Leaderboard section */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-bold uppercase tracking-wider text-gray-400 flex items-center gap-1.5">
                  <Trophy className="w-3.5 h-3.5 text-[#fdd835]" />
                  Global Top 10
                </h3>
                <span className="flex items-center gap-1 text-[10px] text-[#66bb6a] font-bold">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#66bb6a] animate-pulse" />
                  Live
                </span>
              </div>

              {leaderboard.length === 0 ? (
                <div className="text-center py-8 bg-black/10 rounded-xl border border-dashed border-[#444746] text-gray-500">
                  <Sparkles className="w-5 h-5 mx-auto mb-2 text-gray-600 animate-pulse" />
                  <p className="text-xs">No entries yet. Be the first!</p>
                </div>
              ) : (
                <div className="bg-[#1a1a1a] rounded-2xl border border-[#444746] overflow-hidden shadow-inner divide-y divide-gray-800/50">
                  {leaderboard.map((entry, index) => {
                    const isCurrentUser = currentUser?.uid === entry.userId;
                    const rank = index + 1;
                    let rankBg = "bg-[#2a2a2a] text-gray-400";
                    if (rank === 1) rankBg = "bg-[#fdd835] text-black font-bold";
                    else if (rank === 2) rankBg = "bg-[#b0bec5] text-black font-bold";
                    else if (rank === 3) rankBg = "bg-[#b08d57] text-white font-bold";

                    return (
                      <div 
                        key={entry.id || index}
                        className={`p-3 flex items-center justify-between transition-all ${isCurrentUser ? 'bg-[#42a5f5]/10 font-medium' : 'hover:bg-[#252525]'}`}
                      >
                        <div className="flex items-center gap-3">
                          <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs ${rankBg}`}>
                            {rank}
                          </div>
                          <div className="text-left">
                            <p className="text-xs font-bold text-white max-w-[150px] truncate">
                              {entry.displayName} {isCurrentUser && <span className="text-[10px] text-[#42a5f5] font-normal">(You)</span>}
                            </p>
                            <p className="text-[9px] text-gray-500">
                              {entry.timestamp?.seconds 
                                ? new Date(entry.timestamp.seconds * 1000).toLocaleDateString()
                                : 'Just now'}
                            </p>
                          </div>
                        </div>
                        <p className="text-xs font-mono font-bold text-[#42a5f5]">
                          {entry.score.toLocaleString()}
                        </p>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-4 space-y-6">
            {/* Status Section */}
            <div>
              <div className="flex items-center gap-2 mb-2 text-[#c4c7c5] text-xs font-bold uppercase tracking-wider">
                <BrainCircuit className="w-3 h-3" /> Status
              </div>
              <div className={`p-3 rounded-lg border ${isAiThinking ? 'bg-[#a8c7fa]/10 border-[#a8c7fa]/30 text-[#a8c7fa]' : 'bg-[#444746]/20 border-[#444746]/50 text-[#c4c7c5]'}`}>
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${isAiThinking ? 'bg-[#a8c7fa] animate-pulse' : 'bg-[#66bb6a]'}`} />
                  <span className="text-sm font-mono">{isAiThinking ? 'Processing Vision...' : 'Waiting for Input'}</span>
                </div>
              </div>
            </div>

            {/* Vision Input */}
            {debugInfo?.screenshotBase64 && (
              <div>
                <div className="flex items-center gap-2 mb-2 text-[#c4c7c5] text-xs font-bold uppercase tracking-wider">
                  <Eye className="w-3 h-3" /> Vision Input
                </div>
                <div className="rounded-lg overflow-hidden border border-[#444746] bg-black/50 relative group">
                  <img src={debugInfo.screenshotBase64} alt="AI Vision" className="w-full h-auto opacity-80 group-hover:opacity-100 transition-opacity" />
                  <div className="absolute bottom-0 left-0 right-0 bg-black/70 p-1 text-[10px] text-center text-gray-400 font-mono">
                    Sent to gemini-3-flash
                  </div>
                </div>
              </div>
            )}

            {/* Prompt Context */}
            {debugInfo?.promptContext && (
              <div>
                <div className="flex items-center gap-2 mb-2 text-[#c4c7c5] text-xs font-bold uppercase tracking-wider">
                  <Terminal className="w-3 h-3" /> Prompt Context
                </div>
                <div className="bg-[#121212] p-3 rounded-lg border border-[#444746] font-mono text-[10px] text-gray-400 h-32 overflow-y-auto whitespace-pre-wrap leading-tight">
                  {debugInfo.promptContext}
                </div>
              </div>
            )}

            {/* AI Output Stats */}
            {debugInfo && (
              <div>
                <div className="flex items-center gap-2 mb-2 text-[#c4c7c5] text-xs font-bold uppercase tracking-wider">
                  <BrainCircuit className="w-3 h-3" /> AI Output
                </div>
                
                <div className="grid grid-cols-2 gap-2 mb-3">
                  <div className="bg-[#2a2a2a] p-2 rounded border border-[#444746]">
                    <p className="text-[10px] text-gray-500 mb-1">Latency</p>
                    <div className="flex items-center gap-1 text-[#a8c7fa] font-mono font-bold">
                      {debugInfo.latency}ms
                    </div>
                  </div>
                  <div className="bg-[#2a2a2a] p-2 rounded border border-[#444746]">
                    <p className="text-[10px] text-gray-500 mb-1">Rec. Color</p>
                    <div className="flex items-center gap-1 text-[#e3e3e3] font-mono font-bold capitalize">
                      {debugInfo.parsedResponse?.recommendedColor || '--'}
                    </div>
                  </div>
                </div>

                {debugInfo.error && (
                  <div className="bg-[#ef5350]/10 border border-[#ef5350]/30 p-3 rounded-lg mb-3">
                    <div className="flex items-start gap-2 text-[#ef5350]">
                      <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                      <div>
                        <p className="text-xs font-bold">PARSE ERROR DETAILS</p>
                        <p className="text-[10px] font-mono mt-1 break-all">{debugInfo.error}</p>
                      </div>
                    </div>
                  </div>
                )}

                <p className="text-[10px] text-gray-500 mb-1">Raw Response Text</p>
                <div className="bg-[#121212] p-3 rounded-lg border border-[#444746] font-mono text-[11px] text-[#66bb6a] max-h-40 overflow-y-auto whitespace-pre-wrap mb-3 border-l-2 border-l-[#66bb6a]">
                  {debugInfo.rawResponse}
                </div>

                <p className="text-[10px] text-gray-500 mb-1">Parsed JSON</p>
                <div className="bg-[#121212] p-3 rounded-lg border border-[#444746] font-mono text-[10px] text-[#a8c7fa] overflow-x-auto">
                  <pre>{JSON.stringify(debugInfo.parsedResponse || { error: "Failed to parse" }, null, 2)}</pre>
                </div>
              </div>
            )}
          </div>
        )}
        
        <div className="p-3 bg-[#252525] border-t border-[#444746] text-center">
            <p className="text-[10px] text-gray-500 font-medium">Powered by Google Gemini 3 Flash</p>
        </div>
      </div>
    </div>
  );
};

export default GeminiSlingshot;