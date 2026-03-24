import React, { useEffect, useRef, useState, useCallback } from "react";
import "./App.css";

import type { LegendItem, BarData, ChartDefinition, Quad, Rect } from "./types";
import { VS_SOURCE, FS_SOURCE } from "./shaders";
import { computeViewRect } from "./utils/mathUtils";
import { QuadNode, buildQuadTree, queryVisibleIndices } from "./utils/quadTree";

const BarChart: React.FC = () => {
    // data grouping
    const [bars, setBars] = useState<BarData[]>([]);
    const [legend, setLegend] = useState<LegendItem[]>([]);
    const [fileLabels, setFileLabels] = useState<
        { name: string; x: number; y: number }[]
    >([]);
    const [titles, setTitles] = useState<string[]>([]);

    // navigation/ui grouping
    const [scale, setScale] = useState(1);
    const [translation, setTranslation] = useState({ x: 0, y: 0 });
    const [isDragging, setIsDragging] = useState(false);
    const [lastMousePos, setLastMousePos] = useState({ x: 0, y: 0 });
    const [uiVisible, setUiVisible] = useState(true);
    const [showLegend, setShowLegend] = useState(false);
    const [culling, setCulling] = useState(true);
    const [showShortcuts, setShowShortcuts] = useState(true);

    // webgl context/shaders
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const glRef = useRef<WebGLRenderingContext | null>(null);
    const programRef = useRef<WebGLProgram | null>(null);

    // webgl buffers/performance refs
    const bufferRef = useRef<WebGLBuffer | null>(null);
    const indexBufferRef = useRef<WebGLBuffer | null>(null);
    const borderBufferRef = useRef<WebGLBuffer | null>(null);
    const indexCountRef = useRef<number>(0);
    const borderVertexCountRef = useRef(0);
    const baseQuadsRef = useRef<Quad[]>([]);
    const quadtreeRef = useRef<QuadNode | null>(null);
    const vertexCountRef = useRef(0);

    /* ================================
     File Upload
  ================================ */

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files) return;

        const allBars: BarData[] = [];
        const labels: { name: string; x: number; y: number }[] = [];
        let combinedLegend: LegendItem[] = [];
        const newTitles: string[] = [];
        const verticalSpacing = 300; // Offset between datasets

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const text = await file.text();

            try {
                const parsed: ChartDefinition = JSON.parse(text);
                const currentYOffset = -(i * verticalSpacing);

                const minX = Math.min(...parsed.bars.map((b) => b.x));
                // Offset the Y position of bars for each subsequent file
                const offsetBars = parsed.bars.map((bar) => ({
                    ...bar,
                    y: bar.y + currentYOffset,
                    sourceFile: file.name,
                }));

                allBars.push(...offsetBars);
                labels.push({ name: file.name, x: minX, y: currentYOffset });
                if (parsed.title) {
                    newTitles.push(parsed.title);
                }

                // Merge legends if they are different (or just take the first)
                if (i === 0) combinedLegend = parsed.legend;
            } catch (err) {
                console.error(`Failed to parse ${file.name}`, err);
            }
        }

        const globalMinX =
            allBars.length > 0 ? Math.min(...allBars.map((b) => b.x)) : 0;

        setTitles(newTitles);
        setBars(allBars);
        setLegend(combinedLegend);
        setFileLabels(labels);
        setScale(1);
        setTranslation({ x: -globalMinX + 50, y: 0 });
    };

    // geometry groupings
    // generate bar graph data
    const generateGeometry = useCallback(() => {
        const gl = glRef.current;
        const buffer = bufferRef.current;
        if (!gl || !buffer) return;

        const vertexData: number[] = [];
        const baseQuads: Quad[] = [];

        bars.forEach((bar) => {
            const total = bar.segments.reduce((a, b) => a + b, 0);
            if (total === 0) return;

            let accumulatedHeight = 0;

            bar.segments.forEach((value, i) => {
                const segmentHeight = (value / total) * bar.h;

                const x1 = bar.x;
                const x2 = bar.x + bar.w;

                const yTop = bar.y - accumulatedHeight;
                const yBottom = bar.y - accumulatedHeight - segmentHeight;

                const color = legend[i]?.color ?? [1, 1, 1, 1];

                // Store quad for quadtree
                baseQuads.push({
                    x: x1,
                    y: yBottom,
                    w: x2 - x1,
                    h: yTop - yBottom,
                    color,
                });

                // Push 6 vertices (static order)
                vertexData.push(
                    x1,
                    yTop,
                    ...color,
                    x2,
                    yTop,
                    ...color,
                    x1,
                    yBottom,
                    ...color,

                    x1,
                    yBottom,
                    ...color,
                    x2,
                    yTop,
                    ...color,
                    x2,
                    yBottom,
                    ...color,
                );

                accumulatedHeight += segmentHeight;
            });
        });

        baseQuadsRef.current = baseQuads;
        quadtreeRef.current = buildQuadTree(baseQuads);

        const floatData = new Float32Array(vertexData);

        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, floatData, gl.STATIC_DRAW);

        vertexCountRef.current = floatData.length / 6;
    }, [bars, legend]);

    //
    // generate border buffer
    //
    const generateBorderBuffer = useCallback(() => {
        const gl = glRef.current;
        if (!gl) return;

        const borderBuffer = gl.createBuffer();
        borderBufferRef.current = borderBuffer;

        const cx = 0;
        const cy = 0;

        const borderColor = [0.4, 0.4, 0.4, 1];

        const data = new Float32Array([
            cx - 300,
            cy + 100,
            ...borderColor,
            cx + 300,
            cy + 100,
            ...borderColor,
            cx + 300,
            cy - 200,
            ...borderColor,
            cx - 300,
            cy - 200,
            ...borderColor,
        ]);

        gl.bindBuffer(gl.ARRAY_BUFFER, borderBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

        borderVertexCountRef.current = 4;
    }, []);

    // webgl rendering group
    const updateIndexBufferFromCulling = useCallback(
        (width: number, height: number) => {
            const gl = glRef.current;
            const indexBuffer = indexBufferRef.current;
            const baseQuads = baseQuadsRef.current;
            const quadtree = quadtreeRef.current;
            const canvas = canvasRef.current;

            if (!gl || !indexBuffer || !quadtree || !canvas) return;

            const viewRect = computeViewRect(
                { x: width, y: height },
                translation,
                scale,
            );

            const visibleQuadIndices = culling
                ? queryVisibleIndices(quadtree, baseQuads, viewRect)
                : baseQuads.map((_, i) => i);

            const indexData: number[] = [];

            visibleQuadIndices.forEach((quadIndex) => {
                const baseVertex = quadIndex * 6;

                indexData.push(
                    baseVertex + 0,
                    baseVertex + 1,
                    baseVertex + 2,
                    baseVertex + 3,
                    baseVertex + 4,
                    baseVertex + 5,
                );
            });

            const uintData = new Uint32Array(indexData);

            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, uintData, gl.DYNAMIC_DRAW);

            indexCountRef.current = uintData.length;
        },
        [scale, translation],
    );

    const draw = useCallback(() => {
        const canvas = canvasRef.current;
        const gl = glRef.current;
        const program = programRef.current;
        const buffer = bufferRef.current;
        const borderBuffer = borderBufferRef.current;

        if (!canvas || !gl || !program || !buffer || !borderBuffer) return;

        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;

        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0.05, 0.05, 0.05, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.useProgram(program);

        const positionLoc = gl.getAttribLocation(program, "a_position");
        const colorLoc = gl.getAttribLocation(program, "a_color");

        const resLoc = gl.getUniformLocation(program, "u_resolution");
        const transLoc = gl.getUniformLocation(program, "u_translation");
        const scaleLoc = gl.getUniformLocation(program, "u_scale");

        gl.uniform2f(resLoc, canvas.width, canvas.height);
        gl.uniform2f(transLoc, translation.x, translation.y);
        gl.uniform1f(scaleLoc, scale);

        const stride = 6 * 4; // 6 floats per vertex

        updateIndexBufferFromCulling(canvas.width, canvas.height);

        /* ===== Draw Bars ===== */
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);

        gl.enableVertexAttribArray(positionLoc);
        gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, stride, 0);

        gl.enableVertexAttribArray(colorLoc);
        gl.vertexAttribPointer(colorLoc, 4, gl.FLOAT, false, stride, 2 * 4);

        // ALWAYS bind index buffer right before drawing
        const indexBuffer = indexBufferRef.current;
        if (!indexBuffer) {
            console.log("Index buffer is NULL, exiting draw()");
            return 0;
        }

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
        gl.drawElements(
            gl.TRIANGLES,
            indexCountRef.current,
            gl.UNSIGNED_INT,
            0,
        );

        /* ===== Draw Border ===== */
        gl.bindBuffer(gl.ARRAY_BUFFER, borderBuffer);

        gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, stride, 0);

        gl.vertexAttribPointer(colorLoc, 4, gl.FLOAT, false, stride, 2 * 4);

        gl.drawArrays(gl.LINE_LOOP, 0, borderVertexCountRef.current);
    }, [scale, translation]);

    // USE_EFFECTS grouping

    // webgl init
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const gl = canvas.getContext("webgl2");
        if (!gl) return;

        glRef.current = gl;

        const createShader = (
            gl: WebGLRenderingContext,
            type: number,
            source: string,
        ) => {
            const shader = gl.createShader(type)!;
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            return shader;
        };

        const program = gl.createProgram()!;
        gl.attachShader(program, createShader(gl, gl.VERTEX_SHADER, VS_SOURCE));
        gl.attachShader(
            program,
            createShader(gl, gl.FRAGMENT_SHADER, FS_SOURCE),
        );
        gl.linkProgram(program);

        programRef.current = program;
        bufferRef.current = gl.createBuffer();
    }, []);
    // regenerates the geometry when data changes
    useEffect(() => {
        if (bars.length > 0) {
            generateGeometry();
            generateBorderBuffer();
        }
    }, [bars, legend, generateGeometry, generateBorderBuffer]);
    //redraws when view/data changes
    useEffect(() => {
        draw();
    }, [draw]);

    useEffect(() => {
        const gl = glRef.current;
        if (!gl) return;
        indexBufferRef.current = gl.createBuffer();
    }, []);

    // handles the zooming QOL feature
    useEffect(() => {
        const handleWheel = (e: WheelEvent) => {
            e.preventDefault();

            const zoomIntensity = 0.001;
            const delta = -e.deltaY * zoomIntensity;
            const newScale = Math.max(0.1, Math.min(scale * (1 + delta), 20));

            const cx = window.innerWidth / 2;
            const cy = window.innerHeight / 2;

            // Zoom in → anchor to mouse
            const anchorX = e.deltaY < 0 ? e.clientX - cx : 0;
            const anchorY = e.deltaY < 0 ? e.clientY - cy : 0;

            const worldX = anchorX / scale - translation.x;
            const worldY = anchorY / scale - translation.y;

            setTranslation({
                x: anchorX / newScale - worldX,
                y: anchorY / newScale - worldY,
            });

            setScale(newScale);
        };

        window.addEventListener("wheel", handleWheel, { passive: false });
        return () => window.removeEventListener("wheel", handleWheel);
    }, [scale, translation]);

    // handles the ui QOL feature
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Ignore if typing in input field
            const active = document.activeElement;
            if (
                active instanceof HTMLInputElement ||
                active instanceof HTMLTextAreaElement
            ) {
                return;
            }

            // alt+K → toggle UI
            if (e.altKey && e.key.toLowerCase() === "k") {
                e.preventDefault();
                setUiVisible((prev) => !prev);
            }

            // alt+M → toggle shortcuts panel
            if (e.altKey && e.key.toLowerCase() === "m") {
                e.preventDefault();
                setShowShortcuts((prev) => !prev);
            }

            // alt+c -> toggle culling
            if (e.altKey && e.key.toLowerCase() === "c") {
                e.preventDefault();
                setCulling((prev) => !prev);
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, []);

    // mouse dragging feature
    const handleMouseDown = (e: React.MouseEvent) => {
        // Only start dragging if clicking the canvas (not UI buttons)
        if ((e.target as HTMLElement).tagName === "CANVAS") {
            setIsDragging(true);
            setLastMousePos({ x: e.clientX, y: e.clientY });
        }
    };

    // mouse dragging feature
    const handleMouseMove = (e: React.MouseEvent) => {
        if (!isDragging) return;

        // Calculate how far the mouse moved since the last frame
        const dx = e.clientX - lastMousePos.x;
        const dy = e.clientY - lastMousePos.y;

        // Update translation.
        // We divide by scale so that dragging feels consistent regardless of zoom level.
        setTranslation((prev) => ({
            x: prev.x + dx / scale,
            y: prev.y + dy / scale,
        }));

        // Update the reference point for the next movement
        setLastMousePos({ x: e.clientX, y: e.clientY });
    };

    // mouse dragging feature
    const handleMouseUp = () => {
        setIsDragging(false);
    };

    const hasValidData = legend.length > 0 && bars.length > 0;

    return (
        <div
            className="webgl-container"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            style={{ cursor: isDragging ? "grabbing" : "crosshair" }}
        >
            <canvas ref={canvasRef} />

            {uiVisible && (
                <>
                    <ChartOverlays
                        titles={titles}
                        fileLabels={fileLabels}
                        bars={bars}
                        scale={scale}
                        translation={translation}
                    />

                    <ControlPanel
                        hasValidData={hasValidData}
                        handleFileUpload={handleFileUpload}
                        setShowLegend={setShowLegend}
                        showLegend={showLegend}
                        scale={scale}
                        culling={culling}
                        bars={bars}
                        setScale={setScale}
                        setTranslation={setTranslation}
                        legend={legend}
                    />
                </>
            )}

            {showShortcuts && <ShortcutsPanel />}
        </div>
    );
};

export default BarChart;

// title and labels return block
const ChartOverlays: React.FC<{
    titles: string[];
    fileLabels: { name: string; x: number; y: number }[];
    bars: BarData[];
    scale: number;
    translation: { x: number; y: number };
}> = ({ titles, fileLabels, bars, scale, translation }) => {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;

    return (
        <div className="ui-overlay">
            {/* Titles Mapping */}
            {titles.map((title, i) => (
                <div
                    key={`title-${i}`}
                    className="chart-title"
                    style={{
                        left: `${cx + translation.x * scale}px`,
                        top: `${cy + (-(i * 300) - 200 + translation.y) * scale}px`,
                    }}
                >
                    {title}
                </div>
            ))}

            {/* File Source Labels Mapping */}
            {fileLabels.map((file, i) => (
                <div
                    key={`file-${i}`}
                    className="file-header-label"
                    style={{
                        left: `${cx + (file.x + translation.x) * scale}px`,
                        top: `${cy + (file.y + translation.y - 100) * scale}px`,
                    }}
                >
                    SOURCE: {file.name}
                </div>
            ))}

            {/* Bar Labels (with Zoom/Viewport Culling) */}
            {scale >= 0.8 &&
                bars.map((bar, i) => {
                    const left =
                        cx + (bar.x + bar.w / 2 + translation.x) * scale;
                    const top = cy + (bar.y + 20 + translation.y) * scale;

                    if (
                        left < -100 ||
                        left > window.innerWidth + 100 ||
                        top < -100 ||
                        top > window.innerHeight + 100
                    )
                        return null;

                    return (
                        <div key={i} className="label" style={{ left, top }}>
                            {bar.label}
                        </div>
                    );
                })}
        </div>
    );
};

// control panel and legend logic
const ControlPanel: React.FC<{
    hasValidData: boolean;
    handleFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
    setShowLegend: React.Dispatch<React.SetStateAction<boolean>>;
    showLegend: boolean;
    scale: number;
    culling: boolean;
    bars: BarData[];
    setScale: (s: number) => void;
    setTranslation: (t: { x: number; y: number }) => void;
    legend: LegendItem[];
}> = ({
    hasValidData,
    handleFileUpload,
    setShowLegend,
    showLegend,
    scale,
    culling,
    bars,
    setScale,
    setTranslation,
    legend,
}) => (
    <div className="controls">
        <input
            type="file"
            accept=".json"
            multiple
            onChange={handleFileUpload}
        />
        <button
            onClick={() => setShowLegend(!showLegend)}
            disabled={!hasValidData}
            className={!hasValidData ? "disabled-button" : ""}
        >
            {showLegend ? "Hide Legend" : "Show Legend"}
        </button>

        <div className="zoom-indicator">ZOOM: {scale.toFixed(2)}x</div>
        <div className="culling-indicator">
            CULLING: {culling ? "ON" : "OFF"}
        </div>

        <button
            onClick={() => {
                const minX =
                    bars.length > 0 ? Math.min(...bars.map((b) => b.x)) : 0;
                setScale(1);
                setTranslation({ x: -minX + 50, y: 0 });
            }}
        >
            Reset View
        </button>

        {showLegend && (
            <div className="legend" style={{ display: "flex" }}>
                {legend.map((item, i) => {
                    const [r, g, b, a] = item.color.map((c, idx) =>
                        idx < 3 ? Math.round(c * 255) : c,
                    );
                    return (
                        <div key={i} className="legend-item">
                            <div
                                className="legend-color"
                                style={{
                                    backgroundColor: `rgba(${r}, ${g}, ${b}, ${a})`,
                                }}
                            />
                            <span>{item.name}</span>
                        </div>
                    );
                })}
            </div>
        )}
    </div>
);

// shortcuts panel logic
const ShortcutsPanel = () => (
    <div className="shortcuts-panel">
        <div className="shortcuts-title">Keyboard Shortcuts</div>
        <div>alt + K → Toggle UI</div>
        <div>alt + M → Toggle Help</div>
        <div>alt + c → Toggle culling</div>
        <div>Mouse Wheel → Zoom</div>
    </div>
);
