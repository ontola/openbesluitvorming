declare module "react-pdf/dist/entry.webpack" {
  import * as React from 'react';

  interface CommonPdfProps {
    error?: React.ReactNode | Function;
    // TODO: Change to real ref type
    inputRef?: (ref: any) => void;
    loading?: React.ReactNode | Function;
    noData?: React.ReactNode | Function;
    onLoadError?: (error: Error) => void;
    onLoadSuccess?: (pdf: Pdf) => void;

  }

  interface Pdf {
    numPages: number;
  }

  interface DocumentProps extends CommonPdfProps {
    file: string | File;

    onItemClick?: (pageNumber: number) => void;
    onSourceError?: (error: Error) => void;
    rotate?: 0 | 90 | 180 | 270;

  }
  class Document extends React.Component<DocumentProps>{}

  interface PageProps extends CommonPdfProps {
    customTextRenderer?: (args: { str: string, itemIndex: number }) => React.ReactNode;
    onRenderError?: (error: Error) => void;
    onRenderSuccess?: () => void;
    // TODO: Add array typings
    onGetAnnotationsSuccess?: (annotations: any[]) => void;
    onGetAnnotationsError?: (error: Error) => void;
    // TODO: Add array typings
    onGetTextSuccess?: (items: any[]) => void;
    onGetTextError?: (error: Error) => void;

    pageIndex?: number;
    pageNumber?: number;
    renderAnnotations?: boolean;
    renderTextLayer?: boolean;
    rotate?: 0 | 90 | 180 | 270;
    scale?: number;
    width?: number;
  }
  class Page extends React.Component<PageProps>{}

  interface OutlineProps {
    onItemClick?: (pageNumber: number) => void;
    onLoadError?: (error: Error) => void;
    onLoadSuccess?: (pdf: Pdf) => void;
    onParseError?: (error: Error) => void;
    // TODO: Add array typings
    onParseSuccess?: (outline: any[]) => void;
  }
  class Outline extends React.Component<OutlineProps>{}
}
