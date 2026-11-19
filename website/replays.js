export default {
  "inngest": {
    "before": {
      "sourceFiles": 55,
      "wouldChangeFiles": 7,
      "findings": [
        {
          "code": "T1",
          "kind": "applied",
          "count": 7
        },
        {
          "code": "T1",
          "kind": "review",
          "count": 2
        },
        {
          "code": "F4",
          "kind": "review",
          "count": 1
        },
        {
          "code": "F12",
          "kind": "review",
          "count": 1
        }
      ],
      "note": "The scanner proposed edits in the same seven function files the maintainer changed.",
      "highlights": [
        [
          "T1",
          "Move legacy trigger arguments into function options."
        ],
        [
          "F4",
          "Review the event schema against the v4 types."
        ]
      ]
    },
    "after": {
      "sourceFiles": 55,
      "wouldChangeFiles": 0,
      "findings": [
        {
          "code": "T1",
          "kind": "review",
          "count": 2
        },
        {
          "code": "F12",
          "kind": "review",
          "count": 1
        }
      ],
      "note": "Proposed edits fell to zero after the migration. Three conservative review findings remained.",
      "highlights": [
        [
          "T1",
          "Two client references still warranted manual checks."
        ],
        [
          "F12",
          "The scanner requested a deployment review."
        ]
      ]
    }
  },
  "knock": {
    "before": {
      "sourceFiles": 7,
      "wouldChangeFiles": 6,
      "findings": [
        {
          "code": "K2",
          "kind": "applied",
          "count": 1
        },
        {
          "code": "K3",
          "kind": "applied",
          "count": 1
        },
        {
          "code": "K4",
          "kind": "applied",
          "count": 10
        },
        {
          "code": "K5",
          "kind": "applied",
          "count": 4
        },
        {
          "code": "KF1",
          "kind": "review",
          "count": 1
        },
        {
          "code": "KF6",
          "kind": "review",
          "count": 2
        }
      ],
      "note": "Across the seven changed example files, the scanner proposed 16 edits and identified three type decisions for a reviewer.",
      "highlights": [
        [
          "K2",
          "Rename users.identify to users.update."
        ],
        [
          "K5",
          "Move the API key and legacy host into v1 client options."
        ],
        [
          "KF6",
          "Narrow provider-specific channel data before reading connections."
        ]
      ]
    },
    "after": {
      "sourceFiles": 7,
      "wouldChangeFiles": 0,
      "findings": [],
      "note": "On the maintainer’s merged revisions of these seven files, the scanner proposed zero edits and raised zero manual findings.",
      "highlights": []
    }
  }
};
