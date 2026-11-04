import React, { useEffect, useId, useRef, useState } from 'react';
import mermaid from 'mermaid';
import DOMPurify from 'dompurify';

interface MermaidRendererProps {
  chart: string;
  id: string;
}

export const MermaidRenderer: React.FC<MermaidRendererProps> = ({ chart, id }) => {
  const elementRef = useRef<HTMLDivElement>(null);
  const instanceId = useId().replace(/:/g, '');
  const renderSequence = useRef(0);
  const [hasError, setHasError] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    const renderChart = async () => {
      if (!elementRef.current || !chart) return;

      // Mermaid uses CSS selectors internally; each instance/render owns its ID.
      const graphId = `mermaid-${instanceId}-${++renderSequence.current}`;

      try {
        // Clear any previous content
        elementRef.current.innerHTML = '';
        setHasError(false);

        // Configure mermaid
        const isDarkTheme = document.documentElement.classList.contains('dark');

        mermaid.initialize({
          startOnLoad: false,
          theme: isDarkTheme ? 'dark' : 'default',
          // Charts come from untrusted READMEs and agent output: 'strict' encodes
          // label HTML and disables click callbacks.
          securityLevel: 'strict',
          fontFamily: 'monospace',
        });

        // Render the chart
        const { svg } = await mermaid.render(graphId, chart);

        // Strict mode already sanitizes the SVG; sanitize again where it is inserted, with
        // mermaid's own settings, so this stays safe if that changes. Flowchart labels are
        // HTML inside foreignObject, so it must stay an HTML integration point.
        if (elementRef.current) {
          elementRef.current.innerHTML = DOMPurify.sanitize(svg, {
            ADD_TAGS: ['foreignobject'],
            ADD_ATTR: ['dominant-baseline'],
            HTML_INTEGRATION_POINTS: { foreignobject: true },
          });
        }
      } catch (error: unknown) {
        console.error('Mermaid rendering error:', error);
        setHasError(true);

        // Extract meaningful error message
        let message = 'Failed to render diagram';
        if (error instanceof Error) {
          // Clean up the error message - remove version info and extra details
          message = error.message
            .replace(/mermaid version [\d.]+/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
        }
        setErrorMessage(message);

        // Remove only this render's SVG and Mermaid's temporary container.
        // Other previews may already contain successfully rendered diagrams.
        document.getElementById(graphId)?.remove();
        document.getElementById(`d${graphId}`)?.remove();

        // Try to clean up mermaid's internal state
        try {
          // @ts-expect-error - Mermaid API types don't include reset method
          if (window.mermaid?.mermaidAPI?.reset) {
            // @ts-expect-error - Mermaid API types don't include reset method
            window.mermaid.mermaidAPI.reset();
          }
        } catch {
          // Ignore reset errors
        }
      }
    };

    // Render with a small delay to ensure DOM is ready
    const timer = setTimeout(renderChart, 50);
    return () => clearTimeout(timer);
  }, [chart, id, instanceId]);

  if (hasError) {
    return (
      <div className="border border-status-error/30 rounded p-2 bg-status-error/5 text-sm">
        <p className="text-text-primary">
          <span className="font-semibold">⚠ Diagram error:</span>{' '}
          <span className="text-text-primary">{errorMessage}</span>
        </p>
      </div>
    );
  }

  return (
    <div 
      ref={elementRef}
      className="mermaid-container my-4 flex justify-center items-center min-h-[100px]"
    />
  );
};
