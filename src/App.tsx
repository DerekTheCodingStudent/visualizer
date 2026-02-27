import React, { useEffect, useRef, useState, useCallback } from "react";
import "./App.css";

/* ================================
   Types
================================ */

interface LegendItem {
  name: string;
  color: [number, number, number, number];
}

interface BarData {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  segments: number[];
}

interface ChartDefinition {
  legend: LegendItem[];
  bars: BarData[];
}

/* ================================
   Shaders
================================ */

const VS_SOURCE = `
attribute vec2 a_position;
attribute vec4 a_color;

uniform vec2 u_resolution;
uniform vec2 u_translation;
uniform float u_scale;

varying vec4 v_color;
void main() {
  vec2 position = (a_position + u_translation) * u_scale;

  vec2 zeroToOne = (position + u_resolution / 2.0) / u_resolution;
  vec2 clipSpace = zeroToOne * 2.0 - 1.0;

  gl_Position = vec4(clipSpace * vec2(1.0, -1.0), 0.0, 1.0);
  v_color = a_color;
}
`;

const FS_SOURCE = `
precision mediump float;
varying vec4 v_color;
void main() {
  gl_FragColor = v_color;
}
`;

/* ================================
   Component
================================ */

const BarChart: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<WebGLRenderingContext | null>(null);
  const programRef = useRef<WebGLProgram | null>(null);
  const bufferRef = useRef<WebGLBuffer | null>(null);
  const vertexCountRef = useRef(0);
  const borderVertexCountRef = useRef(0);

  const borderBufferRef = useRef<WebGLBuffer | null>(null);

  const [bars, setBars] = useState<BarData[]>([]);
  const [legend, setLegend] = useState<LegendItem[]>([]);
  const [scale, setScale] = useState(1);
  const [translation, setTranslation] = useState({ x: 0, y: 0 });
  const [showLegend, setShowLegend] = useState(false);
  const [uiVisible, setUiVisible] = useState(true);
  const [showShortcuts, setShowShortcuts] = useState(true);

  /* ================================
     File Upload
  ================================ */

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();

    reader.onload = (event) => {
      try {
        const parsed: ChartDefinition = JSON.parse(
          event.target?.result as string
        );

        if (!parsed.bars || !parsed.legend) {
          throw new Error("Invalid chart definition");
        }

        setBars(parsed.bars);
        setLegend(parsed.legend);
        setScale(1);
        setTranslation({ x: 0, y: 0 });
      } catch {
        alert("Invalid JSON format");
      }
    };

    reader.readAsText(file);

    generateGeometry();
    generateBorderBuffer();
  };

  /* ================================
     WebGL Initialization (once)
  ================================ */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext("webgl");
    if (!gl) return;

    glRef.current = gl;

    const createShader = (
      gl: WebGLRenderingContext,
      type: number,
      source: string
    ) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return shader;
    };

    const program = gl.createProgram()!;
    gl.attachShader(program, createShader(gl, gl.VERTEX_SHADER, VS_SOURCE));
    gl.attachShader(program, createShader(gl, gl.FRAGMENT_SHADER, FS_SOURCE));
    gl.linkProgram(program);

    programRef.current = program;
    bufferRef.current = gl.createBuffer();
  }, []);

  // generate bar graph data
  const generateGeometry = useCallback(() => {
    console.log("running geometry");
    const gl = glRef.current;
    const buffer = bufferRef.current;
    if (!gl || !buffer) return;

    const vertexData: number[] = [];

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

        // 2 triangles per segment
        vertexData.push(
          x1, yTop,    ...color,
          x2, yTop,    ...color,
          x1, yBottom, ...color,

          x1, yBottom, ...color,
          x2, yTop,    ...color,
          x2, yBottom, ...color
        );

        accumulatedHeight += segmentHeight;
      });
    });

    const floatData = new Float32Array(vertexData);

    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, floatData, gl.STATIC_DRAW);

    vertexCountRef.current = floatData.length / 6; // 6 floats per vertex
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
      cx - 300, cy + 100, ...borderColor,
      cx + 300, cy + 100, ...borderColor,
      cx + 300, cy - 200, ...borderColor,
      cx - 300, cy - 200, ...borderColor,
    ]);

    gl.bindBuffer(gl.ARRAY_BUFFER, borderBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

    borderVertexCountRef.current = 4;
  }, []);

  /* ================================
     Draw Function
  ================================ */

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

    /* ===== Draw Bars ===== */
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);

    gl.enableVertexAttribArray(positionLoc);
    gl.vertexAttribPointer(
      positionLoc,
      2,
      gl.FLOAT,
      false,
      stride,
      0
    );

    gl.enableVertexAttribArray(colorLoc);
    gl.vertexAttribPointer(
      colorLoc,
      4,
      gl.FLOAT,
      false,
      stride,
      2 * 4
    );

    gl.drawArrays(gl.TRIANGLES, 0, vertexCountRef.current);

    /* ===== Draw Border ===== */
    gl.bindBuffer(gl.ARRAY_BUFFER, borderBuffer);

    gl.vertexAttribPointer(
      positionLoc,
      2,
      gl.FLOAT,
      false,
      stride,
      0
    );

    gl.vertexAttribPointer(
      colorLoc,
      4,
      gl.FLOAT,
      false,
      stride,
      2 * 4
    );

    gl.drawArrays(gl.LINE_LOOP, 0, borderVertexCountRef.current);

  }, [scale, translation]);

  useEffect(() => {
    generateGeometry();
    generateBorderBuffer();
  }, [generateGeometry, generateBorderBuffer]);

  useEffect(() => {
    generateGeometry();
  }, [generateGeometry]);

  useEffect(() => {
    draw();
  }, [draw]);

  console.log("Vertex Count:", vertexCountRef.current);

  /* ================================
     Zoom Handling
  ================================ */

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
        setUiVisible(prev => !prev);
      }

      // alt+M → toggle shortcuts panel
      if (e.altKey && e.key.toLowerCase() === "m") {
        e.preventDefault();
        setShowShortcuts(prev => !prev);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  /* ================================
     JSX
  ================================ */

  const hasValidData = legend.length > 0 && bars.length > 0;

  return (
    <div className="webgl-container">
      <canvas ref={canvasRef} />
      {uiVisible && (
        <div className="ui-overlay">
          {bars.map((bar, i) => {
            const cx = window.innerWidth / 2;
            const cy = window.innerHeight / 2;

            const left =
              cx + (bar.x + bar.w / 2 + translation.x) * scale;
            const top =
              cy + (bar.y + 20 + translation.y) * scale;

            return (
              <div key={i} className="label" style={{ left, top }}>
                {bar.label}
              </div>
            );
          })} 
          </div>
      )}
      {uiVisible && (
        <div className="controls">
          <input type="file" accept=".json" onChange={handleFileUpload} />
          <button
            onClick={() => {
              //if (!hasValidData) return;
              setShowLegend(prev => !prev);
            }}
            disabled={!hasValidData}
            className={!hasValidData ? "disabled-button" : ""}
          >
            {showLegend ? "Hide Legend" : "Show Legend"}
          </button>

          <div className="zoom-indicator">
            ZOOM: {scale.toFixed(2)}x
          </div>

          <button
            onClick={() => {
              setScale(1);
              setTranslation({ x: 0, y: 0 });
            }}
          >
            RESET VIEW
          </button>

          {/* Legend */}
            <div className="legend"
            style={{ display: showLegend ? "flex" : "none" }}
            >
              {legend.map((item, i) => {
                const r = Math.round(item.color[0] * 255);
                const g = Math.round(item.color[1] * 255);
                const b = Math.round(item.color[2] * 255);
                const a = item.color[3];

                return (
                  <div key={i} className="legend-item">
                    <div
                      className="legend-color"
                      style={{
                        backgroundColor: `rgba(${r}, ${g}, ${b}, ${a})`
                      }}
                    />
                    <span>{item.name}</span>
                  </div>
                );
              })}
            </div>
        </div>
      )}
      {showShortcuts && (
        <div className="shortcuts-panel">
          <div className="shortcuts-title">Keyboard Shortcuts</div>
          <div>alt + K → Toggle UI</div>
          <div>alt + M → Toggle Help</div>
          <div>Mouse Wheel → Zoom</div>
        </div>
      )}
    </div>
  );
};

export default BarChart;