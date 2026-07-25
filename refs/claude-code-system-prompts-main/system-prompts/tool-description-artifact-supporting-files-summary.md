<!--
name: "Tool Description: Artifact supporting files summary"
description: "Summarizes an Artifact publish with a computed count of supporting files"
ccVersion: "2.1.216"
variables:
  - "SUPPORTING_FILE_COUNT"
  - "PLURALIZE_FN"
-->
Render an HTML or Markdown file to an Artifact together with ${SUPPORTING_FILE_COUNT} supporting ${PLURALIZE_FN(SUPPORTING_FILE_COUNT,"file")}
