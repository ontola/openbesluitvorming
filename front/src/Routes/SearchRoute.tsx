import * as React from "react";
import Filtersbar from "../Components/FiltersBar";
import ResultsList from "../Components/ResultsList";
import NavBar from "../Components/NavBar";
import PDFViewer from "../Components/PDFViewer";

const SearchRoute = () => {
  const [showFilters, setShowFilters] = React.useState(false);
  const [showPDF, setShowPDF] = React.useState(false);

  return (
    <div className="SearchRoute">
      <NavBar/>
      <div className="Wrapper">
        <div
          style={{
            display: showFilters ? "block" : "none",
          }}
          className="FilterBar"
        >
          <Filtersbar/>
        </div>
        <div className="ResultsBar">
          <div className="Results">
            <button
              onClick={() => setShowFilters(!showFilters)}
            >
              Filters {showFilters ? "verbergen" : "tonen"}
            </button>
            <button
              onClick={() => setShowPDF(!showPDF)}
            >
              PDF {showPDF ? "verbergen" : "tonen"}
            </button>
            <ResultsList/>
          </div>
          {!showPDF &&
            <div className="Widgets">
              <div className="Widget">
                <h2>Meldingen ontvangen</h2>
                {/* tslint:disable-next-line:max-line-length */}
                <p>Wil je een e-mail ontvangen wanneer er nieuwe items worden geplaatst over duurzaamheid?</p>
              </div>
            </div>
          }
        </div>
        {showPDF &&
          <div className="ResourceBar">
            <button
              onClick={() => setShowPDF(false)}
            >
              Sluiten
            </button>
            <PDFViewer
              url={"https://api.notubiz.nl/document/7208290/3"}
            />
          </div>
        }
      </div>
    </div>
  );
};

export default SearchRoute;
