let snapshots = [];


async function loadSnapshots() {

  try {

    toast(
      "Loading snapshots..."
    );


    const response =
      await fetch(
        `/api/snapshots?region=${encodeURIComponent(getRegion())}`
      );


    const data =
      await response.json();


    if (!response.ok) {

      throw new Error(
        data.message
      );

    }


    snapshots =
      data;


    renderSnapshots(
      snapshots
    );


  } catch (error) {

    toast(
      error.message
    );

  }

}


function renderSnapshots(data) {

  const table =
    document.getElementById(
      "snapshotTable"
    );


  table.innerHTML = "";


  if (!data.length) {

    table.innerHTML = `
      <tr>
        <td colspan="7">
          <div class="empty">
            No snapshots found.
          </div>
        </td>
      </tr>
    `;

    return;

  }


  data.forEach(snapshot => {

    const row =
      document.createElement("tr");


    row.innerHTML = `

      <td class="mono">
        ${escapeHtml(snapshot.snapshotId)}
      </td>

      <td class="mono">
        ${escapeHtml(snapshot.volumeId)}
      </td>

      <td>
        ${snapshot.size} GB
      </td>

      <td>
        ${statusHtml(snapshot.state)}
      </td>

      <td>
        ${snapshot.encrypted ? "Yes" : "No"}
      </td>

      <td>
        ${formatDate(snapshot.startTime)}
      </td>

      <td>
        ${escapeHtml(snapshot.description)}
      </td>

    `;


    table.appendChild(row);

  });

}


document.addEventListener(
  "DOMContentLoaded",
  () => {

    loadSnapshots();


    const search =
      document.getElementById(
        "snapshotSearch"
      );


    search.addEventListener(
      "input",
      () => {

        const term =
          search.value
            .toLowerCase()
            .trim();


        const filtered =
          snapshots.filter(
            snapshot =>
              JSON.stringify(snapshot)
                .toLowerCase()
                .includes(term)
          );


        renderSnapshots(
          filtered
        );

      }
    );

  }
);
