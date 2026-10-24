import React, { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';
import DOMPurify from 'dompurify';

interface MermaidRendererProps {
  chart: string;
  id: string;
}

export const MermaidRenderer: React.FC<MermaidRendererProps> = ({ chart, id }) => {
  const elementRef = useRef<HTMLDivElement>(null);
  const [hasError, setHasError] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    const renderChart = async () => {
      if (!elementRef.current || !chart) return;

      // Create a unique ID for this render (define it outside try block)
      const graphId = `mermaid-${id}-${Date.now()}`;

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

        // Clean up any error SVGs that mermaid may have inserted
        const errorElements = document.querySelectorAll(`#${graphId}, [id^="mermaid-"]`);
        errorElements.forEach(el => {
          if (el.parentNode) {
            el.parentNode.removeChild(el);
          }
        });

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
  }, [chart, id]);

  if (hasError) {
    return (
      <div className="border border-status-error/30 rounded p-2 bg-status-error/5 text-sm">
        <p className="text-status-error">
          <span className="font-semibold">⚠ Diagram error:</span>{' '}
          <span className="text-status-error/90">{errorMessage}</span>
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
