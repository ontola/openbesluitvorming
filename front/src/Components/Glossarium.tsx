import * as React from "react";

interface MState {
  visible?: boolean,
  selectedText?: string
}

interface MProps {}

class Glossarium extends React.PureComponent<MProps, MState> {
  constructor(props: {}) {
    super(props);
    this.state = {
      visible: false
    }
  }


  componentDidMount() {
    document.addEventListener('selectionchange', this.evaluateSelection);
  }

  evaluateSelection = () => {
    var selected = document.getSelection();
    var sel:Selection = {} as Selection;
    if (selected !== null) {
      sel = selected;
    }
    this.setState({
      visible: true,
      selectedText: sel.toString()
    })
  }


  render() {
    return (
      <div>
        {this.state.visible &&
        <div className="Glossarium">
          {this.state.selectedText}
        </div>}
      </div>
    );
  }
}


export default Glossarium;