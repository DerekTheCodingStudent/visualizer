import React, { useEffect, useRef, useState, useCallback } from "react";
import "./App.css";

import type {
    LegendItem,
    BarData,
    ChartDefinition,
    Quad,
    Orientation,
} from "./types";
import { VS_SOURCE, FS_SOURCE } from "./shaders";
import {
    computeViewRect,
    computeBoundingBox,
    remapQuadsToBoundingBox,
    getChartPlotBBox,
    mapPointBetweenBBoxes,
    mapDataXToPlotWorld,
    mapDataYToPlotWorld,
} from "./utils/mathUtils";
import { QuadNode, buildQuadTree, queryVisibleIndices } from "./utils/quadTree";

const trackSpacing = 100;
/** Plot-world units: vertical category labels sit just below the chart bbox (outside the frame). */
const verticalLabelBelowPlotWorld = 14;
/** Screen px: nudge the vertical-mode axis title left so it does not overlap tick values. */
const verticalAxisTitleOutwardPx = 36;

/** Segment quads in data space (same layout as WebGL before remap to the plot box). */
function collectBarSegmentQuads(
    bars: BarData[],
    legend: LegendItem[],
    orientation: Orientation,
): Quad[] {
    const quads: Quad[] = [];

    bars.forEach((bar) => {
        const total = bar.segments.reduce((a, b) => a + b, 0);
        if (total === 0) return;

        let offset = 0;
        const scaledY = bar.y * trackSpacing;

        bar.segments.forEach((value, i) => {
            let x1: number;
            let x2: number;
            let yTop: number;
            let yBottom: number;
            const color = legend[i]?.color ?? [1, 1, 1, 1];

            if (orientation === "horizontal") {
                const segmentWidth = (value / total) * bar.h;
                x1 = bar.y + offset;
                x2 = x1 + segmentWidth;
                yTop = bar.x + bar.w;
                yBottom = bar.x;
                offset += segmentWidth;
            } else {
                const segmentHeight = (value / total) * bar.h;
                x1 = bar.x;
                x2 = bar.x + bar.w;
                yBottom = scaledY + offset;
                yTop = yBottom + segmentHeight;
                offset += segmentHeight;
            }

            quads.push({
                x: x1,
                y: yBottom,
                w: x2 - x1,
                h: yTop - yBottom,
                color,
            });
        });
    });

    return quads;
}

const BarChart: React.FC = () => {
    // data grouping
    const [bars, setBars] = useState<BarData[]>([]);
    const [legend, setLegend] = useState<LegendItem[]>([]);
    const [fileLabels, setFileLabels] = useState<
        { name: string; x: number; y: number }[]
    >([]);
    const [titles, setTitles] = useState<string[]>([]);
    const [unit, setUnit] = useState<string>("unit");

    // navigation/ui grouping
    const [scale, setScale] = useState(1);
    const [translation, setTranslation] = useState({ x: 0, y: 0 });
    const [isDragging, setIsDragging] = useState(false);
    const [lastMousePos, setLastMousePos] = useState({ x: 0, y: 0 });
    const [uiVisible, setUiVisible] = useState(true);
    const [showLegend, setShowLegend] = useState(false);
    const [culling, setCulling] = useState(false);
    const [showShortcuts, setShowShortcuts] = useState(true);
    const [orientation, setOrientation] = useState<Orientation>("horizontal");

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
        const fList = e.target.files;
        if (!fList) return;

        const files = Array.from(fList);
        const allBars: BarData[] = [];
        const labels: { name: string; x: number; y: number }[] = [];
        let combinedLegend: LegendItem[] = [];
        const newTitles: string[] = [];
        let totalY = 0;
        let barCount = 0;

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            try {
                // Read the actual file content
                const text = await file.text();
                const parsed: ChartDefinition = JSON.parse(text);

                if (parsed.unit) {
                    setUnit(parsed.unit);
                }

                // Set legend from the first file to enable UI and colors
                if (i === 0) combinedLegend = parsed.legend;
                if (parsed.title) newTitles.push(parsed.title);

                const fileYOffset = -(i * 10);
                const minX =
                    parsed.bars.length > 0
                        ? Math.min(...parsed.bars.map((b) => b.x))
                        : 0;

                parsed.bars.forEach((bar) => {
                    const adjustedY = bar.y + fileYOffset;
                    allBars.push({
                        ...bar,
                        y: adjustedY,
                        sourceFile: file.name,
                    });
                    totalY += adjustedY;
                    barCount++;
                });

                labels.push({ name: file.name, x: minX, y: fileYOffset });
            } catch (err) {
                console.error(`Failed to parse ${file.name}`, err);
            }
        }
        if (allBars.length === 0) return;

        // Center the lanes around Y = 0
        const centerY = barCount > 0 ? totalY / barCount : 0;
        const centeredBars = allBars.map((bar) => ({
            ...bar,
            y: bar.y - centerY,
        }));

        const minX = Math.min(...centeredBars.map((b) => b.x));
        const maxX = Math.max(...centeredBars.map((b) => b.x + b.w));
        const minY = Math.min(...centeredBars.map((b) => b.y * trackSpacing));
        const maxY = Math.max(...centeredBars.map((b) => b.y * trackSpacing));
        const dataCenterX = (minX + maxX) / 2;
        const dataCenterY = (minY + maxY) / 2;

        setTitles(newTitles);
        setLegend(combinedLegend);
        setFileLabels(labels);
        setBars(centeredBars);

        setScale(1);
        setTranslation({ x: -dataCenterX, y: -dataCenterY });
    };

    // geometry groupings
    // generate bar graph data
    const generateGeometry = useCallback(() => {
        const gl = glRef.current;
        const buffer = bufferRef.current;
        if (!gl || !buffer) return;

        const vertexData: number[] = [];
        const baseQuads = collectBarSegmentQuads(bars, legend, orientation);

        const srcBBox = computeBoundingBox(baseQuads);
        const plotQuads =
            srcBBox != null
                ? remapQuadsToBoundingBox(
                      baseQuads,
                      srcBBox,
                      getChartPlotBBox(),
                  )
                : baseQuads;

        plotQuads.forEach((q) => {
            const x1 = q.x;
            const x2 = q.x + q.w;
            const yBottom = q.y;
            const yTop = q.y + q.h;
            const color = q.color ?? [1, 1, 1, 1];

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
        });

        baseQuadsRef.current = plotQuads;
        quadtreeRef.current = buildQuadTree(plotQuads);

        const floatData = new Float32Array(vertexData);

        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, floatData, gl.STATIC_DRAW);

        vertexCountRef.current = floatData.length / 6;
    }, [bars, legend, orientation]);

    //
    // generate border buffer
    //
    const generateBorderBuffer = useCallback(() => {
        const gl = glRef.current;
        if (!gl) return;

        const borderBuffer = gl.createBuffer();
        borderBufferRef.current = borderBuffer;

        const b = getChartPlotBBox();
        const borderColor = [0.4, 0.4, 0.4, 1];

        const data = new Float32Array([
            b.minX,
            b.maxY,
            ...borderColor,
            b.maxX,
            b.maxY,
            ...borderColor,
            b.maxX,
            b.minY,
            ...borderColor,
            b.minX,
            b.minY,
            ...borderColor,
        ]);
        console.log(data);
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
        [scale, translation, culling],
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
        gl.clearColor(1.0, 1.0, 1.0, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.useProgram(program);

        const positionLoc = gl.getAttribLocation(program, "a_position");
        const colorLoc = gl.getAttribLocation(program, "a_color");

        const resLoc = gl.getUniformLocation(program, "u_resolution");
        const transLoc = gl.getUniformLocation(program, "u_translation");
        const scaleLoc = gl.getUniformLocation(program, "u_scale");
        const flipLoc = gl.getUniformLocation(program, "u_flip");

        gl.uniform2f(resLoc, canvas.width, canvas.height);
        gl.uniform2f(transLoc, translation.x, translation.y);
        gl.uniform1f(scaleLoc, scale);
        gl.uniform1i(flipLoc, orientation === "horizontal" ? 1 : 0);

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

        console.log("index count: ", indexCountRef.current);

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
        gl.drawElements(
            gl.TRIANGLES,
            indexCountRef.current,
            gl.UNSIGNED_INT,
            0,
        );

        /* ===== Draw Border ===== */
        const noFlip = 0;
        gl.uniform1i(flipLoc, noFlip);
        gl.bindBuffer(gl.ARRAY_BUFFER, borderBuffer);

        gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, stride, 0);

        gl.vertexAttribPointer(colorLoc, 4, gl.FLOAT, false, stride, 2 * 4);

        gl.drawArrays(gl.LINE_LOOP, 0, borderVertexCountRef.current);
    }, [scale, translation, orientation, updateIndexBufferFromCulling]);

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
                        legend={legend}
                        scale={scale}
                        translation={translation}
                        orientation={orientation}
                    />

                    <XAxis
                        bars={bars}
                        legend={legend}
                        orientation={orientation}
                        scale={scale}
                        translation={translation}
                        unit={unit}
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
                        orientation={orientation}
                        setOrientation={setOrientation}
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
    legend: LegendItem[];
    scale: number;
    translation: { x: number; y: number };
    orientation: Orientation;
}> = ({ titles, fileLabels, bars, legend, scale, translation, orientation }) => {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;

    const dataQuads = collectBarSegmentQuads(bars, legend, orientation);
    const srcBBox = computeBoundingBox(dataQuads);
    const destBBox = getChartPlotBBox();

    const labels = new Set<string>();

    const worldToScreen = (wx: number, wy: number) => ({
        left: cx + (wx + translation.x) * scale,
        top: cy + (wy + translation.y) * scale,
    });

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

            {/* Bar labels: vertical → below bar (plot bottom); horizontal → left of bar (category axis). */}
            {scale >= 0.8 &&
                bars.map((bar, i) => {
                    const currLabel = `${bar.label}_${bar.y}`;

                    if (labels.has(currLabel)) {
                        return null;
                    }

                    let worldX: number;
                    let worldY: number;
                    if (orientation === "vertical") {
                        // X: center of bar in data space → plot X. Y: baseline just under the plot
                        // (HTML overlay Y: larger world Y → lower on screen; chart bottom is maxY).
                        const dataX = bar.x + bar.w / 2;
                        worldX =
                            srcBBox != null
                                ? mapDataXToPlotWorld(dataX, srcBBox, destBBox)
                                : dataX;
                        worldY =
                            destBBox.maxY + verticalLabelBelowPlotWorld;
                    } else {
                        const dataX = bar.y;
                        const dataY = bar.x + bar.w / 2;
                        const p =
                            srcBBox != null
                                ? mapPointBetweenBBoxes(
                                      dataX,
                                      dataY,
                                      srcBBox,
                                      destBBox,
                                  )
                                : { x: dataX, y: dataY };
                        worldX = p.x;
                        worldY = p.y;
                    }

                    const { left, top } = worldToScreen(worldX, worldY);
                    const labelBottomPx = window.innerHeight - top - 8;

                    if (
                        left < -100 ||
                        left > window.innerWidth + 100 ||
                        top < -100 ||
                        top > window.innerHeight + 100
                    )
                        return null;

                    labels.add(currLabel);

                    const labelStyle: React.CSSProperties =
                        orientation === "vertical"
                            ? {
                                  left: `${left}px`,
                                  top: "auto",
                                  bottom: `${labelBottomPx}px`,
                                  transform: "translate(-50%, 0)",
                              }
                            : {
                                  left: `${left - 8}px`,
                                  top: `${top}px`,
                                  transform: "translate(-100%, -50%)",
                              };

                    return (
                        <div key={i} className="label" style={labelStyle}>
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
    orientation: Orientation;
    setOrientation: React.Dispatch<React.SetStateAction<Orientation>>;
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
    orientation,
    setOrientation,
}) => (
    <div className="controls">
        <input
            type="file"
            accept=".json"
            multiple
            onChange={handleFileUpload}
        />

        <button
            onClick={() =>
                setOrientation((prev) =>
                    prev === "horizontal" ? "vertical" : "horizontal",
                )
            }
            disabled={!hasValidData}
        >
            MODE: {orientation.toUpperCase()}
        </button>
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
                if (bars.length === 0) return;

                const minX = Math.min(...bars.map((b) => b.x));
                const maxX = Math.max(...bars.map((b) => b.x + b.w));
                const minY = Math.min(...bars.map((b) => b.y * trackSpacing));
                const maxY = Math.max(...bars.map((b) => b.y * trackSpacing));

                const dataCenterX = (minX + maxX) / 2;
                const dataCenterY = (minY + maxY) / 2;

                setScale(1);
                // Translation is inverse of world position to bring it to (0,0) screen space
                setTranslation({
                    x: -dataCenterX,
                    y: -dataCenterY,
                });
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

function niceTickIntervalFromRough(rough: number): number {
    if (!Number.isFinite(rough) || rough <= 0) return 1;
    const exponent = Math.floor(Math.log10(rough));
    const fraction = rough / Math.pow(10, exponent);
    let base: number;
    if (fraction < 1.5) base = 1;
    else if (fraction < 3) base = 2;
    else if (fraction < 7) base = 5;
    else base = 10;
    return base * Math.pow(10, exponent);
}

// Horizontal mode: units axis along bottom (X). Vertical mode: units axis along left (Y).
const XAxis: React.FC<{
    bars: BarData[];
    legend: LegendItem[];
    orientation: Orientation;
    scale: number;
    translation: { x: number; y: number };
    unit: string;
}> = ({ bars, legend, orientation, scale, translation, unit }) => {
    if (bars.length === 0) return null;

    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;

    const dataQuads = collectBarSegmentQuads(bars, legend, orientation);
    const srcBBox = computeBoundingBox(dataQuads);
    const destBBox = getChartPlotBBox();

    const targetSpacingPx = 100;

    if (orientation === "vertical") {
        const lineX = cx + (destBBox.minX + translation.x) * scale;
        const topEdge = cy + (destBBox.minY + translation.y) * scale;
        const lineHeight = destBBox.h * scale;

        let yTicks: number[] = [];
        if (srcBBox != null && srcBBox.h > 0 && destBBox.h > 0) {
            const rough =
                (targetSpacingPx * srcBBox.h) / (destBBox.h * scale);
            const interval = niceTickIntervalFromRough(rough);
            const startTick = Math.ceil(srcBBox.minY / interval) * interval;
            for (let t = startTick; t <= srcBBox.maxY + 1e-9; t += interval) {
                yTicks.push(t);
            }
        }

        const axisTitleTop = topEdge + lineHeight / 2;

        return (
            <div
                className="axis-relative-container axis-relative-container--fill"
            >
                <div
                    className="axis-line-vertical"
                    style={{
                        left: `${lineX}px`,
                        top: `${topEdge}px`,
                        height: `${lineHeight}px`,
                    }}
                />

                {srcBBox != null &&
                    yTicks.map((tick) => {
                        const plotY = mapDataYToPlotWorld(
                            tick,
                            srcBBox,
                            destBBox,
                        );
                        const tickTop =
                            cy + (plotY + translation.y) * scale;
                        if (
                            tickTop < -40 ||
                            tickTop > window.innerHeight + 40
                        )
                            return null;

                        return (
                            <div
                                key={tick}
                                className="axis-y-tick-row"
                                style={{
                                    top: `${tickTop}px`,
                                    left: `${lineX}px`,
                                }}
                            >
                                <span className="tick-value axis-y-tick-value">
                                    {tick.toLocaleString()} {unit}
                                </span>
                                <div className="axis-y-tick-mark" />
                            </div>
                        );
                    })}

                <div
                    className="axis-title axis-title-vertical"
                    style={{
                        left: `${lineX - verticalAxisTitleOutwardPx}px`,
                        top: `${axisTitleTop}px`,
                    }}
                >
                    Time ({unit})
                </div>
            </div>
        );
    }

    const axisYWorld = destBBox.maxY;
    const axisYScreen = cy + (axisYWorld + translation.y) * scale;
    const lineLeft = cx + (destBBox.minX + translation.x) * scale;
    const lineWidth = destBBox.w * scale;

    const worldUnitsPerTick = targetSpacingPx / scale;
    const interval = niceTickIntervalFromRough(worldUnitsPerTick);

    const ticks: number[] = [];
    if (srcBBox != null && srcBBox.w > 0) {
        const startTick = Math.ceil(srcBBox.minX / interval) * interval;
        for (let t = startTick; t <= srcBBox.maxX + 1e-9; t += interval) {
            ticks.push(t);
        }
    } else {
        const leftWorld = -cx / scale - translation.x;
        const rightWorld = cx / scale - translation.x;
        const startTick = Math.max(Math.ceil(leftWorld / interval) * interval, 0);
        for (let t = startTick; t <= rightWorld; t += interval) {
            ticks.push(t);
        }
    }

    const axisTitleLeft =
        cx +
        ((destBBox.minX + destBBox.maxX) / 2 + translation.x) * scale;

    return (
        <div
            className="axis-relative-container"
            style={{ top: `${axisYScreen}px` }}
        >
            <div
                className="axis-line"
                style={{
                    left: `${lineLeft}px`,
                    width: `${lineWidth}px`,
                }}
            />

            {ticks.map((tick) => {
                const plotX =
                    srcBBox != null && srcBBox.w > 0
                        ? mapDataXToPlotWorld(tick, srcBBox, destBBox)
                        : tick;
                const tickLeft = cx + (plotX + translation.x) * scale;
                if (tickLeft < -80 || tickLeft > window.innerWidth + 80)
                    return null;

                return (
                    <div
                        key={tick}
                        className="tick-container"
                        style={{ left: `${tickLeft}px` }}
                    >
                        <div className="tick-mark" />
                        <span className="tick-value">
                            {tick.toLocaleString()} {unit}
                        </span>
                    </div>
                );
            })}

            <div
                className="axis-title"
                style={{ left: `${axisTitleLeft}px` }}
            >
                Time ({unit})
            </div>
        </div>
    );
};
